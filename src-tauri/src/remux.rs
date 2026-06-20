//! On-device MKV→fragmented-MP4 remux (no re-encode), for platforms that can't spawn
//! ffmpeg (iOS). WKWebView only plays H.264/HEVC video + AAC audio in an MP4/MOV/HLS
//! container, but a huge share of downloaded video is exactly those codecs *inside a
//! Matroska (.mkv) container*. Repackaging the container — copying the already-compatible
//! samples into fragmented MP4 — makes them playable without touching the bitstream.
//!
//! Matroska conveniently stores the codec configuration we need directly:
//!   * `V_MPEG4/ISO/AVC`  → CodecPrivate **is** the `avcC` box payload (→ `avc1`)
//!   * `V_MPEGH/ISO/HEVC` → CodecPrivate **is** the `hvcC` box payload (→ `hvc1`)
//!   * `A_AAC`            → CodecPrivate **is** the AAC AudioSpecificConfig (→ `esds`)
//! and H.264/HEVC frames are already length-prefixed (AVCC form), i.e. exactly MP4's
//! sample format — so samples are copied verbatim into `mdat`.
//!
//! Anything else (AC-3/DTS/Opus audio, MPEG-4 ASP/VP9 video, …) genuinely needs decoding,
//! which we can't do on-device, so those return [`RemuxError::Unsupported`] and the caller
//! surfaces an honest "format unsupported" message.

use std::io::{Read, Seek};

/// Why a remux couldn't be produced.
#[derive(Debug)]
pub enum RemuxError {
    /// The track codecs can't be copy-remuxed (would need a real transcode). The string
    /// is a short human description, e.g. "audio codec A_AC3 needs transcoding".
    Unsupported(String),
    /// I/O or container-parse failure.
    Io(String),
}

impl std::fmt::Display for RemuxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemuxError::Unsupported(s) => write!(f, "unsupported: {s}"),
            RemuxError::Io(s) => write!(f, "io: {s}"),
        }
    }
}
impl std::error::Error for RemuxError {}

/// Remux a Matroska (MKV/WebM) stream into fragmented MP4, copying samples (no re-encode).
///
/// Reads from `src` (a synchronous `Read + Seek`; call this from a blocking context — it
/// blocks). Emits the fMP4 byte stream by calling `sink` with each output chunk in order
/// (an init segment `ftyp`+`moov`, then `moof`+`mdat` fragments). If `sink` returns
/// `false` (client disconnected) the remux stops early with `Ok(())`.
///
/// Supported: one H.264 (`avc1`) or HEVC (`hvc1`) video track + at most one AAC (`mp4a`)
/// audio track. Returns [`RemuxError::Unsupported`] if neither is present in a copyable form.
pub fn remux_mkv_to_fmp4<R: Read + Seek>(
    src: R,
    mut sink: impl FnMut(&[u8]) -> bool,
) -> Result<(), RemuxError> {
    use matroska_demuxer::{Frame, MatroskaFile, TrackType};

    // ---- Open the container -------------------------------------------------
    let mut mkv = MatroskaFile::open(src).map_err(|e| RemuxError::Io(format!("open mkv: {e}")))?;

    // timestamp_scale is nanoseconds-per-tick (1_000_000 ⇒ ms ticks). `Frame.timestamp`
    // from this crate is in *raw ticks* (cluster timestamp + block relative offset), so
    // `ns = ticks * timestamp_scale`. Verified against block.rs / next_frame() in 0.7.0.
    let ts_scale_ns = mkv.info().timestamp_scale().get();

    // ---- Pick the video track (required) ------------------------------------
    let mut video: Option<TrackInfo> = None;
    for t in mkv.tracks() {
        if t.track_type() != TrackType::Video {
            continue;
        }
        let kind = match t.codec_id() {
            "V_MPEG4/ISO/AVC" => VideoKind::Avc,
            "V_MPEGH/ISO/HEVC" => VideoKind::Hevc,
            _ => continue, // not copyable as-is
        };
        let v = t
            .video()
            .ok_or_else(|| RemuxError::Io("video track missing Video element".into()))?;
        let codec_private = t
            .codec_private()
            .ok_or_else(|| {
                RemuxError::Unsupported("video track missing codec_private (avcC/hvcC)".into())
            })?
            .to_vec();
        video = Some(TrackInfo {
            mkv_track: t.track_number().get(),
            kind: TrackKind::Video(kind),
            width: u32::try_from(v.pixel_width().get()).unwrap_or(0),
            height: u32::try_from(v.pixel_height().get()).unwrap_or(0),
            sample_rate: 0,
            channels: 0,
            codec_private,
        });
        break;
    }
    let video = video.ok_or_else(|| RemuxError::Unsupported("no H.264/HEVC video track".into()))?;

    // ---- Pick the audio track (optional, AAC only) --------------------------
    // If an audio track exists but isn't AAC we must NOT silently drop it.
    let mut audio: Option<TrackInfo> = None;
    for t in mkv.tracks() {
        if t.track_type() != TrackType::Audio {
            continue;
        }
        if t.codec_id() != "A_AAC" {
            return Err(RemuxError::Unsupported(format!(
                "audio codec {} needs transcoding",
                t.codec_id()
            )));
        }
        let a = t
            .audio()
            .ok_or_else(|| RemuxError::Io("audio track missing Audio element".into()))?;
        let codec_private = t
            .codec_private()
            .ok_or_else(|| {
                RemuxError::Unsupported("AAC track missing codec_private (AudioSpecificConfig)".into())
            })?
            .to_vec();
        audio = Some(TrackInfo {
            mkv_track: t.track_number().get(),
            kind: TrackKind::Audio,
            width: 0,
            height: 0,
            sample_rate: a.sampling_frequency() as u32,
            channels: u16::try_from(a.channels().get()).unwrap_or(2),
            codec_private,
        });
        break;
    }

    // Timescales: video uses a fixed 90 kHz clock (standard for video), audio uses its
    // sample rate (so AAC sample durations land on integer frame counts).
    const VIDEO_TIMESCALE: u32 = 90_000;
    let audio_timescale = audio.as_ref().map(|a| a.sample_rate.max(1)).unwrap_or(1);

    // MP4 track ids: video = 1, audio = 2.
    let video_track_id: u32 = 1;
    let audio_track_id: u32 = 2;
    let track_count = if audio.is_some() { 2 } else { 1 };

    // ---- Init segment: ftyp + moov ------------------------------------------
    let mut init = Vec::with_capacity(1024);
    write_ftyp(&mut init);
    write_moov(
        &mut init,
        &video,
        video_track_id,
        VIDEO_TIMESCALE,
        audio.as_ref(),
        audio_track_id,
        audio_timescale,
        track_count + 1,
    );
    if !sink(&init) {
        return Ok(());
    }

    // ---- Streaming demux → fragments ----------------------------------------
    // Per-track running decode time (in that track's timescale) for tfdt baseMediaDecodeTime.
    let mut video_base_dts: u64 = 0;
    let mut audio_base_dts: u64 = 0;
    let mut sequence_number: u32 = 1;

    // Reorder window for video DTS derivation (handles B-frames). MKV delivers video
    // frames in *decode* order, with PTS in `timestamp`. We buffer a sliding window and
    // assign DTS = the k-th smallest PTS seen, so DTS is monotonic; cto = PTS - DTS.
    const REORDER_WINDOW: usize = 16;

    // Pending samples awaiting flush, kept in decode order.
    let mut vid_pending: Vec<PendingSample> = Vec::new();
    let mut aud_pending: Vec<PendingSample> = Vec::new();

    // Video reorder state: raw frames (data + pts) buffered in decode order before we can
    // commit DTS/duration. We only finalize a frame once enough later frames exist.
    let mut vid_window: Vec<RawVideo> = Vec::new();
    // PTS values of the buffered frames, kept sorted ascending — DTS values are handed out
    // from the front of this pool so DTS stays monotonic without reordering decode order.
    let mut vid_pts_pool: Vec<u64> = Vec::new();
    // DTS values already handed out, oldest first, so deltas (durations) can be computed
    // once the *next* DTS is known.
    let mut vid_dts_assigned: Vec<u64> = Vec::new();
    // A finalized-but-not-yet-emitted sample whose duration we still owe (needs next DTS).
    let mut vid_awaiting_duration: Option<(PendingSample, u64)> = None; // (sample, its dts)

    // Audio frames buffered awaiting their duration (= delta to next frame's PTS).
    let mut aud_prev: Option<(Vec<u8>, u64)> = None; // (data, pts_in_audio_ts)
    let mut aud_last_dur: u64 = 0;

    // Accumulated video duration in the current fragment (ms), for the ~500 ms flush.
    let mut frag_video_ms: u64 = 0;
    const FRAG_FLUSH_MS: u64 = 500;

    // Convert raw MKV ticks → a target timescale (ns = ticks * scale; then to timescale).
    let to_ts = |ticks: u64, timescale: u32| -> u64 {
        // ns = ticks * ts_scale_ns; out = ns * timescale / 1e9. Use u128 to avoid overflow.
        let ns = (ticks as u128) * (ts_scale_ns as u128);
        (ns * (timescale as u128) / 1_000_000_000u128) as u64
    };

    let mut frame = Frame::default();
    let mut eof = false;
    while !eof {
        eof = !mkv
            .next_frame(&mut frame)
            .map_err(|e| RemuxError::Io(format!("read frame: {e}")))?;

        if !eof {
            if frame.track == video.mkv_track {
                let pts = to_ts(frame.timestamp, VIDEO_TIMESCALE);
                vid_window.push(RawVideo {
                    data: std::mem::take(&mut frame.data),
                    pts,
                    is_key: frame.is_keyframe.unwrap_or(false),
                });
                // Insert the PTS into the sorted pool (binary-search insert keeps it sorted).
                let ins = vid_pts_pool.partition_point(|&p| p < pts);
                vid_pts_pool.insert(ins, pts);
                frame.data = Vec::new(); // restore a buffer for the demuxer to reuse

                // Once the window is full enough, finalize the oldest frame: its DTS is the
                // smallest PTS currently buffered (which won't change as more arrive past it).
                if vid_window.len() > REORDER_WINDOW {
                    finalize_oldest_video(
                        &mut vid_window,
                        &mut vid_pts_pool,
                        &mut vid_dts_assigned,
                        &mut vid_awaiting_duration,
                        &mut vid_pending,
                        &mut frag_video_ms,
                        VIDEO_TIMESCALE,
                    );
                }
            } else if let Some(a) = audio.as_ref() {
                if frame.track == a.mkv_track {
                    let pts = to_ts(frame.timestamp, audio_timescale);
                    if let Some((pdata, ppts)) = aud_prev.take() {
                        let dur = pts.saturating_sub(ppts);
                        aud_last_dur = if dur > 0 { dur } else { aud_last_dur };
                        aud_pending.push(PendingSample {
                            data: pdata,
                            duration: if dur > 0 { dur } else { aud_last_dur.max(1) },
                            cto: 0,
                            is_key: true, // every AAC frame is a sync sample
                        });
                    }
                    aud_prev = Some((std::mem::take(&mut frame.data), pts));
                    frame.data = Vec::new();
                }
            }
        }

        // Flush a fragment once we've accumulated ~500 ms of video AND the next sample to be
        // committed (the one held in `vid_awaiting_duration`) is a keyframe — so every
        // fragment begins on a sync sample, which WKWebView's strict fMP4 demuxer prefers.
        let next_is_key = vid_awaiting_duration
            .as_ref()
            .map(|(s, _)| s.is_key)
            .unwrap_or(false);
        if frag_video_ms >= FRAG_FLUSH_MS && next_is_key && !eof {
            flush_fragment(
                &mut sink,
                &mut sequence_number,
                video_track_id,
                audio_track_id,
                &mut vid_pending,
                &mut aud_pending,
                &mut video_base_dts,
                &mut audio_base_dts,
            )?;
            frag_video_ms = 0;
        }
    }

    // ---- Drain reorder/audio buffers at EOF ---------------------------------
    // Finalize all remaining buffered video frames in decode order.
    while !vid_window.is_empty() {
        finalize_oldest_video(
            &mut vid_window,
            &mut vid_pts_pool,
            &mut vid_dts_assigned,
            &mut vid_awaiting_duration,
            &mut vid_pending,
            &mut frag_video_ms,
            VIDEO_TIMESCALE,
        );
    }
    // The very last finalized video sample still owes a duration: reuse the prior delta.
    if let Some((mut s, _dts)) = vid_awaiting_duration.take() {
        let last_dur = vid_pending.last().map(|p| p.duration).unwrap_or(0);
        s.duration = last_dur.max(1);
        vid_pending.push(s);
    }
    // Flush the trailing audio frame, reusing the previous duration.
    if let Some((pdata, _ppts)) = aud_prev.take() {
        aud_pending.push(PendingSample {
            data: pdata,
            duration: aud_last_dur.max(1),
            cto: 0,
            is_key: true,
        });
    }

    // Emit the final fragment (if anything is left).
    if !vid_pending.is_empty() || !aud_pending.is_empty() {
        flush_fragment(
            &mut sink,
            &mut sequence_number,
            video_track_id,
            audio_track_id,
            &mut vid_pending,
            &mut aud_pending,
            &mut video_base_dts,
            &mut audio_base_dts,
        )?;
    }

    Ok(())
}

// =============================================================================
// Internal model
// =============================================================================

#[derive(Clone, Copy)]
enum VideoKind {
    Avc,
    Hevc,
}

enum TrackKind {
    Video(VideoKind),
    Audio,
}

/// The bits of a chosen track we need to build the init segment.
struct TrackInfo {
    mkv_track: u64,
    kind: TrackKind,
    width: u32,
    height: u32,
    sample_rate: u32,
    channels: u16,
    /// avcC / hvcC payload (video) or AudioSpecificConfig (audio), verbatim.
    codec_private: Vec<u8>,
}

/// A raw video frame in decode order, before DTS assignment.
struct RawVideo {
    data: Vec<u8>,
    /// Presentation timestamp in the video timescale.
    pts: u64,
    is_key: bool,
}

/// A finalized sample ready to go into a `trun` + `mdat`.
struct PendingSample {
    data: Vec<u8>,
    /// Sample duration in the track timescale.
    duration: u64,
    /// Composition time offset (PTS − DTS), signed, in the track timescale.
    cto: i32,
    is_key: bool,
}

/// Finalize the oldest buffered video frame: assign it a DTS (the smallest PTS currently
/// buffered, which is stable since later-arriving frames can't be smaller within the
/// window), back-fill the *previous* finalized sample's duration (= delta of DTS values),
/// and stash this one until its own successor's DTS is known. Composition offset = PTS−DTS.
///
/// `window` holds raw frames in *decode* order; `pts_pool` holds the PTS values of those
/// frames sorted ascending (used to hand out DTS without disturbing decode order).
fn finalize_oldest_video(
    window: &mut Vec<RawVideo>,
    pts_pool: &mut Vec<u64>,
    dts_assigned: &mut Vec<u64>,
    awaiting_duration: &mut Option<(PendingSample, u64)>,
    out: &mut Vec<PendingSample>,
    frag_video_ms: &mut u64,
    timescale: u32,
) {
    if window.is_empty() {
        return;
    }
    // The oldest *decode-order* frame is committed now.
    let frame = window.remove(0);
    // Its DTS = the smallest PTS still pooled (sorted, so index 0). Removing it keeps the
    // remaining PTS values available for the frames still in the window.
    let dts = if pts_pool.is_empty() {
        frame.pts
    } else {
        pts_pool.remove(0)
    };

    // Keep DTS monotonic non-decreasing even if the window heuristic wobbles.
    let dts = match dts_assigned.last() {
        Some(&prev) if dts < prev => prev,
        _ => dts,
    };
    dts_assigned.push(dts);

    let cto = (frame.pts as i64 - dts as i64) as i32;
    let sample = PendingSample {
        data: frame.data,
        duration: 0, // filled when the next DTS is known
        cto,
        is_key: frame.is_key,
    };

    // Settle the previous sample's duration = delta to this DTS.
    if let Some((mut prev, prev_dts)) = awaiting_duration.take() {
        let dur = dts.saturating_sub(prev_dts);
        prev.duration = dur.max(1);
        // Count toward the fragment-flush budget (convert ts → ms).
        *frag_video_ms += prev.duration * 1000 / timescale.max(1) as u64;
        out.push(prev);
    }
    *awaiting_duration = Some((sample, dts));
}

/// Build one `moof`+`mdat` fragment from the pending video/audio samples, advance the
/// per-track baseMediaDecodeTime, and emit it through `sink`. Clears the pending vecs.
#[allow(clippy::too_many_arguments)]
fn flush_fragment(
    sink: &mut impl FnMut(&[u8]) -> bool,
    sequence_number: &mut u32,
    video_track_id: u32,
    audio_track_id: u32,
    vid_pending: &mut Vec<PendingSample>,
    aud_pending: &mut Vec<PendingSample>,
    video_base_dts: &mut u64,
    audio_base_dts: &mut u64,
) -> Result<(), RemuxError> {
    let has_video = !vid_pending.is_empty();
    let has_audio = !aud_pending.is_empty();
    if !has_video && !has_audio {
        return Ok(());
    }

    // ---- moof ----
    // We build it twice-effectively: assemble traf bodies with placeholder data_offsets,
    // then patch the offsets once the moof size (hence mdat payload start) is known.
    let mut moof = Vec::new();
    let bx = BoxW::start(&mut moof, b"moof");

    // mfhd
    {
        let mfhd = BoxW::start_full(&mut moof, b"mfhd", 0, 0);
        moof.extend_from_slice(&sequence_number.to_be_bytes());
        mfhd.finish(&mut moof);
    }

    // Remember where each trun's data_offset field sits so we can patch it.
    let mut video_data_offset_pos: Option<usize> = None;
    let mut audio_data_offset_pos: Option<usize> = None;

    if has_video {
        video_data_offset_pos =
            Some(write_traf(&mut moof, video_track_id, *video_base_dts, vid_pending, true));
    }
    if has_audio {
        audio_data_offset_pos =
            Some(write_traf(&mut moof, audio_track_id, *audio_base_dts, aud_pending, false));
    }
    bx.finish(&mut moof);

    // ---- mdat ----
    // Payload order matches the trun order: all video samples, then all audio samples.
    let video_bytes: usize = vid_pending.iter().map(|s| s.data.len()).sum();
    let audio_bytes: usize = aud_pending.iter().map(|s| s.data.len()).sum();
    let mdat_payload = video_bytes + audio_bytes;
    let moof_len = moof.len();

    // data_offset is measured from the start of the *moof* (because tfhd sets
    // default-base-is-moof). The mdat payload starts at moof_len + 8 (mdat header).
    let mdat_payload_start = moof_len + 8;
    if let Some(pos) = video_data_offset_pos {
        let off = (mdat_payload_start) as i32;
        moof[pos..pos + 4].copy_from_slice(&off.to_be_bytes());
    }
    if let Some(pos) = audio_data_offset_pos {
        // Audio payload follows the video payload within mdat.
        let off = (mdat_payload_start + video_bytes) as i32;
        moof[pos..pos + 4].copy_from_slice(&off.to_be_bytes());
    }

    // Advance baseMediaDecodeTime by the total duration in each track this fragment.
    *video_base_dts += vid_pending.iter().map(|s| s.duration).sum::<u64>();
    *audio_base_dts += aud_pending.iter().map(|s| s.duration).sum::<u64>();

    // Emit moof.
    if !sink(&moof) {
        vid_pending.clear();
        aud_pending.clear();
        return Ok(());
    }

    // Emit mdat header + payload. Build the header, then stream sample data.
    let mut mdat_hdr = Vec::with_capacity(8);
    let total = (mdat_payload + 8) as u32;
    mdat_hdr.extend_from_slice(&total.to_be_bytes());
    mdat_hdr.extend_from_slice(b"mdat");
    if !sink(&mdat_hdr) {
        vid_pending.clear();
        aud_pending.clear();
        return Ok(());
    }
    for s in vid_pending.iter() {
        if !sink(&s.data) {
            vid_pending.clear();
            aud_pending.clear();
            return Ok(());
        }
    }
    for s in aud_pending.iter() {
        if !sink(&s.data) {
            vid_pending.clear();
            aud_pending.clear();
            return Ok(());
        }
    }

    vid_pending.clear();
    aud_pending.clear();
    Ok(())
}

/// Write one `traf` (tfhd + tfdt + trun) into `buf`. Returns the absolute byte offset
/// *within `buf`* of the 4-byte `trun` data_offset field, for later back-patching.
fn write_traf(
    buf: &mut Vec<u8>,
    track_id: u32,
    base_dts: u64,
    samples: &[PendingSample],
    is_video: bool,
) -> usize {
    let traf = BoxW::start(buf, b"traf");

    // tfhd: flags = default-base-is-moof (0x020000). track_id only.
    {
        let tfhd = BoxW::start_full(buf, b"tfhd", 0, 0x020000);
        buf.extend_from_slice(&track_id.to_be_bytes());
        tfhd.finish(buf);
    }

    // tfdt v1: baseMediaDecodeTime (64-bit).
    {
        let tfdt = BoxW::start_full(buf, b"tfdt", 1, 0);
        buf.extend_from_slice(&base_dts.to_be_bytes());
        tfdt.finish(buf);
    }

    // trun v1. Flags: data-offset (0x000001) | sample-duration (0x000100) |
    // sample-size (0x000200) | sample-flags (0x000400). Video also carries signed
    // composition-time-offsets (0x000800).
    let mut flags = 0x000001 | 0x000100 | 0x000200 | 0x000400;
    if is_video {
        flags |= 0x000800;
    }
    let data_offset_pos;
    {
        let trun = BoxW::start_full(buf, b"trun", 1, flags);
        buf.extend_from_slice(&(samples.len() as u32).to_be_bytes());
        // data_offset placeholder (patched by caller once mdat position is known).
        data_offset_pos = buf.len();
        buf.extend_from_slice(&0i32.to_be_bytes());

        for s in samples {
            buf.extend_from_slice(&s.duration.min(u32::MAX as u64).to_be_bytes()[4..]); // u32 duration
            buf.extend_from_slice(&(s.data.len() as u32).to_be_bytes());
            buf.extend_from_slice(&sample_flags(s.is_key).to_be_bytes());
            // Signed composition time offset (v1). Only present for video per `flags`.
            if is_video {
                buf.extend_from_slice(&s.cto.to_be_bytes());
            }
        }
        trun.finish(buf);
    }

    traf.finish(buf);
    data_offset_pos
}

/// Per-sample flags word for a `trun` entry.
/// Keyframe ⇒ sample_depends_on=2 (I-frame) and sample_is_non_sync_sample=0.
/// Non-key ⇒ sample_is_non_sync_sample=1 (bit 16).
fn sample_flags(is_key: bool) -> u32 {
    if is_key {
        // sample_depends_on = 2 → bits 24..25 = 0b10 → 0x02000000.
        0x0200_0000
    } else {
        // sample_depends_on = 1 (depends on others) + sample_is_non_sync_sample = 1.
        0x0100_0000 | 0x0001_0000
    }
}

// =============================================================================
// MP4 box writers
// =============================================================================

/// A box writer that records where the 32-bit big-endian size goes and back-patches it
/// on `finish`. The size includes the 8-byte header.
struct BoxW {
    size_pos: usize,
}

impl BoxW {
    /// Begin a plain box: writes a placeholder size + 4-char type.
    fn start(buf: &mut Vec<u8>, kind: &[u8; 4]) -> BoxW {
        let size_pos = buf.len();
        buf.extend_from_slice(&[0, 0, 0, 0]); // size placeholder
        buf.extend_from_slice(kind);
        BoxW { size_pos }
    }

    /// Begin a full box: plain header + 1-byte version + 3-byte flags.
    fn start_full(buf: &mut Vec<u8>, kind: &[u8; 4], version: u8, flags: u32) -> BoxW {
        let b = BoxW::start(buf, kind);
        buf.push(version);
        buf.push(((flags >> 16) & 0xFF) as u8);
        buf.push(((flags >> 8) & 0xFF) as u8);
        buf.push((flags & 0xFF) as u8);
        b
    }

    /// Back-patch the size field to cover everything written since `start`.
    fn finish(self, buf: &mut Vec<u8>) {
        let size = (buf.len() - self.size_pos) as u32;
        buf[self.size_pos..self.size_pos + 4].copy_from_slice(&size.to_be_bytes());
    }
}

/// `ftyp`: major_brand iso5, compatible brands isom/iso5/iso6/mp41.
fn write_ftyp(buf: &mut Vec<u8>) {
    let b = BoxW::start(buf, b"ftyp");
    buf.extend_from_slice(b"iso5"); // major_brand
    buf.extend_from_slice(&0u32.to_be_bytes()); // minor_version
    buf.extend_from_slice(b"isom");
    buf.extend_from_slice(b"iso5");
    buf.extend_from_slice(b"iso6");
    buf.extend_from_slice(b"mp41");
    b.finish(buf);
}

#[allow(clippy::too_many_arguments)]
fn write_moov(
    buf: &mut Vec<u8>,
    video: &TrackInfo,
    video_track_id: u32,
    video_timescale: u32,
    audio: Option<&TrackInfo>,
    audio_track_id: u32,
    audio_timescale: u32,
    next_track_id: u32,
) {
    let moov = BoxW::start(buf, b"moov");

    // mvhd (movie timescale 1000, duration 0).
    {
        let mvhd = BoxW::start_full(buf, b"mvhd", 0, 0);
        buf.extend_from_slice(&0u32.to_be_bytes()); // creation_time
        buf.extend_from_slice(&0u32.to_be_bytes()); // modification_time
        buf.extend_from_slice(&1000u32.to_be_bytes()); // timescale
        buf.extend_from_slice(&0u32.to_be_bytes()); // duration (unknown → 0)
        buf.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
        buf.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
        buf.extend_from_slice(&0u16.to_be_bytes()); // reserved
        buf.extend_from_slice(&[0u8; 8]); // reserved
        write_unity_matrix(buf);
        buf.extend_from_slice(&[0u8; 24]); // pre_defined
        buf.extend_from_slice(&next_track_id.to_be_bytes());
        mvhd.finish(buf);
    }

    // Video trak.
    write_trak(
        buf,
        video,
        video_track_id,
        video_timescale,
    );

    // Audio trak (optional).
    if let Some(a) = audio {
        write_trak(buf, a, audio_track_id, audio_timescale);
    }

    // mvex with a trex per track.
    {
        let mvex = BoxW::start(buf, b"mvex");
        write_trex(buf, video_track_id);
        if audio.is_some() {
            write_trex(buf, audio_track_id);
        }
        mvex.finish(buf);
    }

    moov.finish(buf);
}

/// A `trak` for one track.
fn write_trak(buf: &mut Vec<u8>, track: &TrackInfo, track_id: u32, timescale: u32) {
    let trak = BoxW::start(buf, b"trak");

    // tkhd: flags 0x000007 (enabled|in-movie|in-preview), duration 0.
    {
        let tkhd = BoxW::start_full(buf, b"tkhd", 0, 0x000007);
        buf.extend_from_slice(&0u32.to_be_bytes()); // creation_time
        buf.extend_from_slice(&0u32.to_be_bytes()); // modification_time
        buf.extend_from_slice(&track_id.to_be_bytes());
        buf.extend_from_slice(&0u32.to_be_bytes()); // reserved
        buf.extend_from_slice(&0u32.to_be_bytes()); // duration
        buf.extend_from_slice(&[0u8; 8]); // reserved
        buf.extend_from_slice(&0u16.to_be_bytes()); // layer
        buf.extend_from_slice(&0u16.to_be_bytes()); // alternate_group
        let is_audio = matches!(track.kind, TrackKind::Audio);
        let volume: u16 = if is_audio { 0x0100 } else { 0 };
        buf.extend_from_slice(&volume.to_be_bytes());
        buf.extend_from_slice(&0u16.to_be_bytes()); // reserved
        write_unity_matrix(buf);
        // width/height as 16.16 fixed from pixel dims (0 for audio).
        let w: u32 = (track.width as u32) << 16;
        let h: u32 = (track.height as u32) << 16;
        buf.extend_from_slice(&w.to_be_bytes());
        buf.extend_from_slice(&h.to_be_bytes());
        tkhd.finish(buf);
    }

    // mdia.
    {
        let mdia = BoxW::start(buf, b"mdia");

        // mdhd: media timescale, duration 0, language 'und'.
        {
            let mdhd = BoxW::start_full(buf, b"mdhd", 0, 0);
            buf.extend_from_slice(&0u32.to_be_bytes()); // creation_time
            buf.extend_from_slice(&0u32.to_be_bytes()); // modification_time
            buf.extend_from_slice(&timescale.to_be_bytes());
            buf.extend_from_slice(&0u32.to_be_bytes()); // duration
            buf.extend_from_slice(&0x55c4u16.to_be_bytes()); // language 'und'
            buf.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
            mdhd.finish(buf);
        }

        // hdlr: 'vide' or 'soun'.
        {
            let (handler, name): (&[u8; 4], &str) = match track.kind {
                TrackKind::Video(_) => (b"vide", "VideoHandler"),
                TrackKind::Audio => (b"soun", "SoundHandler"),
            };
            let hdlr = BoxW::start_full(buf, b"hdlr", 0, 0);
            buf.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
            buf.extend_from_slice(handler);
            buf.extend_from_slice(&[0u8; 12]); // reserved
            buf.extend_from_slice(name.as_bytes());
            buf.push(0); // null-terminated
            hdlr.finish(buf);
        }

        // minf.
        {
            let minf = BoxW::start(buf, b"minf");

            // vmhd / smhd.
            match track.kind {
                TrackKind::Video(_) => {
                    let vmhd = BoxW::start_full(buf, b"vmhd", 0, 1);
                    buf.extend_from_slice(&0u16.to_be_bytes()); // graphicsmode
                    buf.extend_from_slice(&[0u8; 6]); // opcolor
                    vmhd.finish(buf);
                }
                TrackKind::Audio => {
                    let smhd = BoxW::start_full(buf, b"smhd", 0, 0);
                    buf.extend_from_slice(&0u16.to_be_bytes()); // balance
                    buf.extend_from_slice(&0u16.to_be_bytes()); // reserved
                    smhd.finish(buf);
                }
            }

            // dinf → dref → url  (self-contained, flag 1).
            {
                let dinf = BoxW::start(buf, b"dinf");
                let dref = BoxW::start_full(buf, b"dref", 0, 0);
                buf.extend_from_slice(&1u32.to_be_bytes()); // entry_count
                let url = BoxW::start_full(buf, b"url ", 0, 1); // flag 1 = self-contained
                url.finish(buf);
                dref.finish(buf);
                dinf.finish(buf);
            }

            // stbl.
            {
                let stbl = BoxW::start(buf, b"stbl");

                // stsd.
                {
                    let stsd = BoxW::start_full(buf, b"stsd", 0, 0);
                    buf.extend_from_slice(&1u32.to_be_bytes()); // entry_count
                    match track.kind {
                        TrackKind::Video(kind) => write_video_sample_entry(buf, track, kind),
                        TrackKind::Audio => write_audio_sample_entry(buf, track),
                    }
                    stsd.finish(buf);
                }

                // Empty stts/stsc/stsz/stco (all samples live in fragments).
                write_empty_stts(buf);
                write_empty_stsc(buf);
                write_empty_stsz(buf);
                write_empty_stco(buf);

                stbl.finish(buf);
            }

            minf.finish(buf);
        }

        mdia.finish(buf);
    }

    trak.finish(buf);
}

/// Video sample entry `avc1`/`hvc1` carrying the avcC/hvcC config + dimensions.
fn write_video_sample_entry(buf: &mut Vec<u8>, track: &TrackInfo, kind: VideoKind) {
    let (entry_type, config_type): (&[u8; 4], &[u8; 4]) = match kind {
        VideoKind::Avc => (b"avc1", b"avcC"),
        VideoKind::Hevc => (b"hvc1", b"hvcC"),
    };
    let entry = BoxW::start(buf, entry_type);
    // SampleEntry base.
    buf.extend_from_slice(&[0u8; 6]); // reserved
    buf.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    // VisualSampleEntry.
    buf.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    buf.extend_from_slice(&0u16.to_be_bytes()); // reserved
    buf.extend_from_slice(&[0u8; 12]); // pre_defined[3]
    buf.extend_from_slice(&(track.width as u16).to_be_bytes());
    buf.extend_from_slice(&(track.height as u16).to_be_bytes());
    buf.extend_from_slice(&0x0048_0000u32.to_be_bytes()); // horizresolution 72dpi
    buf.extend_from_slice(&0x0048_0000u32.to_be_bytes()); // vertresolution 72dpi
    buf.extend_from_slice(&0u32.to_be_bytes()); // reserved
    buf.extend_from_slice(&1u16.to_be_bytes()); // frame_count
    buf.extend_from_slice(&[0u8; 32]); // compressorname
    buf.extend_from_slice(&0x0018u16.to_be_bytes()); // depth 24
    buf.extend_from_slice(&0xFFFFu16.to_be_bytes()); // pre_defined = -1

    // avcC / hvcC: the codec_private IS the box payload verbatim.
    {
        let cfg = BoxW::start(buf, config_type);
        buf.extend_from_slice(&track.codec_private);
        cfg.finish(buf);
    }

    entry.finish(buf);
}

/// Audio sample entry `mp4a` with an `esds` carrying the AAC AudioSpecificConfig.
fn write_audio_sample_entry(buf: &mut Vec<u8>, track: &TrackInfo) {
    let entry = BoxW::start(buf, b"mp4a");
    // SampleEntry base.
    buf.extend_from_slice(&[0u8; 6]); // reserved
    buf.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    // AudioSampleEntry.
    buf.extend_from_slice(&[0u8; 8]); // reserved[2]
    buf.extend_from_slice(&track.channels.to_be_bytes()); // channelcount
    buf.extend_from_slice(&16u16.to_be_bytes()); // samplesize
    buf.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    buf.extend_from_slice(&0u16.to_be_bytes()); // reserved
    // samplerate as 16.16 fixed.
    buf.extend_from_slice(&((track.sample_rate as u32) << 16).to_be_bytes());

    write_esds(buf, &track.codec_private);

    entry.finish(buf);
}

/// `esds`: an MPEG-4 ES_Descriptor wrapping the AAC AudioSpecificConfig as the
/// DecoderSpecificInfo. Object type 0x40 (Audio ISO/IEC 14496-3), stream type Audio.
fn write_esds(buf: &mut Vec<u8>, asc: &[u8]) {
    let esds = BoxW::start_full(buf, b"esds", 0, 0);

    // DecoderSpecificInfo (tag 0x05): the AudioSpecificConfig bytes.
    let dsi_len = asc.len();
    // DecoderConfigDescriptor (tag 0x04) body length = 13 fixed fields + dsi header+payload.
    let dcd_len = 13 + 2 + dsi_len;
    // ES_Descriptor (tag 0x03) body = 3 (ES_ID + flags) + dcd header(2)+body + SLConfig(3).
    let esd_len = 3 + 2 + dcd_len + 3;

    // ES_Descriptor.
    buf.push(0x03);
    write_descriptor_len(buf, esd_len);
    buf.extend_from_slice(&0u16.to_be_bytes()); // ES_ID
    buf.push(0x00); // flags

    // DecoderConfigDescriptor.
    buf.push(0x04);
    write_descriptor_len(buf, dcd_len);
    buf.push(0x40); // objectTypeIndication = Audio ISO/IEC 14496-3 (AAC)
    buf.push(0x15); // streamType=Audio(0x05<<2) | upStream=0 | reserved=1 → 0x15
    buf.extend_from_slice(&[0u8; 3]); // bufferSizeDB
    buf.extend_from_slice(&0u32.to_be_bytes()); // maxBitrate
    buf.extend_from_slice(&0u32.to_be_bytes()); // avgBitrate

    // DecoderSpecificInfo.
    buf.push(0x05);
    write_descriptor_len(buf, dsi_len);
    buf.extend_from_slice(asc);

    // SLConfigDescriptor.
    buf.push(0x06);
    write_descriptor_len(buf, 1);
    buf.push(0x02); // predefined = 2 (MP4)

    esds.finish(buf);
}

/// MPEG-4 descriptor length, written here as a single byte (our descriptors are small).
fn write_descriptor_len(buf: &mut Vec<u8>, len: usize) {
    // Sizes here are always < 128, so a one-byte length is valid.
    buf.push((len & 0x7F) as u8);
}

/// `trex`: per-track defaults (default_sample_description_index = 1, rest zero).
fn write_trex(buf: &mut Vec<u8>, track_id: u32) {
    let trex = BoxW::start_full(buf, b"trex", 0, 0);
    buf.extend_from_slice(&track_id.to_be_bytes());
    buf.extend_from_slice(&1u32.to_be_bytes()); // default_sample_description_index
    buf.extend_from_slice(&0u32.to_be_bytes()); // default_sample_duration
    buf.extend_from_slice(&0u32.to_be_bytes()); // default_sample_size
    buf.extend_from_slice(&0u32.to_be_bytes()); // default_sample_flags
    trex.finish(buf);
}

fn write_unity_matrix(buf: &mut Vec<u8>) {
    // 3x3 transform: identity, with the standard 16.16 / 2.30 fixed-point layout.
    const M: [u32; 9] = [
        0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000,
    ];
    for v in M {
        buf.extend_from_slice(&v.to_be_bytes());
    }
}

fn write_empty_stts(buf: &mut Vec<u8>) {
    let b = BoxW::start_full(buf, b"stts", 0, 0);
    buf.extend_from_slice(&0u32.to_be_bytes()); // entry_count
    b.finish(buf);
}
fn write_empty_stsc(buf: &mut Vec<u8>) {
    let b = BoxW::start_full(buf, b"stsc", 0, 0);
    buf.extend_from_slice(&0u32.to_be_bytes()); // entry_count
    b.finish(buf);
}
fn write_empty_stsz(buf: &mut Vec<u8>) {
    let b = BoxW::start_full(buf, b"stsz", 0, 0);
    buf.extend_from_slice(&0u32.to_be_bytes()); // sample_size
    buf.extend_from_slice(&0u32.to_be_bytes()); // sample_count
    b.finish(buf);
}
fn write_empty_stco(buf: &mut Vec<u8>) {
    let b = BoxW::start_full(buf, b"stco", 0, 0);
    buf.extend_from_slice(&0u32.to_be_bytes()); // entry_count
    b.finish(buf);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // Desktop validation harness: REMUX_IN=<mkv> REMUX_OUT=<mp4> cargo test --lib remux_sample -- --nocapture
    // Produces an fMP4 file we then validate externally with ffprobe.
    #[test]
    fn remux_sample() {
        let Ok(inp) = std::env::var("REMUX_IN") else { return };
        let out = std::env::var("REMUX_OUT").unwrap_or_else(|_| "/tmp/remux_out.mp4".into());
        let f = std::fs::File::open(&inp).expect("open input");
        let mut o = std::fs::File::create(&out).expect("create output");
        let mut bytes = 0usize;
        remux_mkv_to_fmp4(f, |chunk| {
            if o.write_all(chunk).is_err() {
                return false;
            }
            bytes += chunk.len();
            true
        })
        .expect("remux failed");
        o.flush().unwrap();
        eprintln!("REMUX_DONE bytes={bytes} out={out}");
        assert!(bytes > 0, "no output produced");
    }
}
