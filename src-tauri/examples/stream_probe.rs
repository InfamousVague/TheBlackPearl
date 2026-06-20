//! Standalone end-to-end probe for the streaming path: add a real magnet, wait
//! for metadata, pick the largest file, and read actual bytes from the swarm —
//! exactly what the GhostWire engine does, minus the axum wrapper.
//!
//! Run: cargo run --example stream_probe -- "<magnet>"

use std::time::Duration;

use librqbit::{AddTorrent, AddTorrentResponse, Session, TorrentStatsState};
use tokio::io::AsyncReadExt;

const SINTEL: &str = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce&tr=udp%3A%2F%2Fexplodie.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let magnet = std::env::args().nth(1).unwrap_or_else(|| SINTEL.to_string());
    let dir = std::env::temp_dir().join("ghosty-probe");
    std::fs::create_dir_all(&dir)?;

    println!("[probe] creating session in {dir:?}");
    let session = Session::new(dir).await?;

    println!("[probe] adding magnet…");
    let resp = session
        .add_torrent(
            AddTorrent::from_url(&magnet),
            Some(librqbit::AddTorrentOptions {
                overwrite: true,
                ..Default::default()
            }),
        )
        .await?;
    let handle = match resp {
        AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => h,
        AddTorrentResponse::ListOnly(_) => anyhow::bail!("list-only"),
    };

    println!("[probe] waiting for torrent to go Live (metadata + storage)…");
    let mut live = false;
    for i in 0..120 {
        let s = handle.stats();
        let peers = s.live.as_ref().map(|l| l.snapshot.peer_stats.live).unwrap_or(0);
        if matches!(s.state, TorrentStatsState::Live) {
            println!("[probe] ✓ Live: total_bytes={} peers={peers}", s.total_bytes);
            live = true;
            break;
        }
        if i % 4 == 0 {
            println!("[probe]   …{i}s state, peers={peers} total_bytes={}", s.total_bytes);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if !live {
        anyhow::bail!("not Live after 120s (no peers reachable?)");
    }

    let (idx, len, name) = handle
        .with_metadata(|m| {
            m.file_infos
                .iter()
                .enumerate()
                .max_by_key(|(_, fi)| fi.len)
                .map(|(i, fi)| (i, fi.len, fi.relative_filename.clone()))
        })?
        .expect("no files");
    println!("[probe] largest file: idx={idx} len={len} name={name:?}");

    println!("[probe] opening stream + reading first bytes (sequential download)…");
    let mut fs = handle.clone().stream(idx)?;
    let mut buf = vec![0u8; 65536];
    let mut read_total = 0usize;
    for _ in 0..120 {
        match tokio::time::timeout(Duration::from_secs(2), fs.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                read_total += n;
                println!("[probe]   read {n} bytes (total {read_total})");
                if read_total >= 32768 {
                    break;
                }
            }
            Ok(Err(e)) => anyhow::bail!("read error: {e}"),
            Err(_) => {
                let s = handle.stats();
                let (down, peers) = s
                    .live
                    .as_ref()
                    .map(|l| (l.download_speed.mbps, l.snapshot.peer_stats.live))
                    .unwrap_or((0.0, 0));
                println!("[probe]   buffering… {down:.2} MiB/s, {peers} peers");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }

    if read_total > 0 {
        println!("[probe] ✅ SUCCESS: streamed {read_total} real bytes of {name:?} while downloading");
        Ok(())
    } else {
        anyhow::bail!("metadata resolved but no file bytes streamed");
    }
}
