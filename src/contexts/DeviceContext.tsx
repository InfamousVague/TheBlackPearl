import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { IN_TAURI } from "../ipc/engine";
import { getSetting, setSetting } from "../ipc/library";
import { setActiveDevice, type LinkedDevice } from "../ipc/remote";
import { clearSnapshot } from "../lib/snapshotCache";

// The linked Mac is restored from settings asynchronously (getSetting), so on the first frame
// `linkedMac` is still null. We ALSO mirror just the deviceId to localStorage synchronously, so
// the cold-start snapshot read knows which host it belongs to before the async restore lands.
const LINKED_ID_KEY = "ghosty.linkedDeviceId";
export function readLinkedDeviceIdSync(): string | null {
  try {
    return localStorage.getItem(LINKED_ID_KEY);
  } catch {
    return null;
  }
}

// App-wide "linked Mac" state. When set (on the iPad), downloads can be pushed to the Mac
// and content streamed from it. Persisted in the settings table (Tauri) / localStorage (web).

interface DeviceContextValue {
  linkedMac: LinkedDevice | null;
  link: (device: LinkedDevice) => Promise<void>;
  unlink: () => Promise<void>;
}

const KEY = "linked_device";
const DeviceContext = createContext<DeviceContextValue>({
  linkedMac: null,
  link: async () => {},
  unlink: async () => {},
});

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [linkedMac, setLinkedMac] = useState<LinkedDevice | null>(null);

  // Keep the module-level holder in sync so the plain ipc/* functions (no React context)
  // can route reads/playback to the linked Mac in companion mode. Also mirror the deviceId to
  // localStorage (incl. on async restore) so the next cold start can match its persisted snapshot.
  useEffect(() => {
    setActiveDevice(linkedMac);
    try {
      if (linkedMac) localStorage.setItem(LINKED_ID_KEY, linkedMac.deviceId);
      else localStorage.removeItem(LINKED_ID_KEY);
    } catch {
      /* ignore storage failures */
    }
  }, [linkedMac]);

  useEffect(() => {
    const parse = (s: string | null | undefined) => {
      if (!s) return;
      try {
        const dev = JSON.parse(s) as LinkedDevice;
        setLinkedMac(dev);
        // Eager: set the module holder NOW (not just in the effect, which for this ancestor
        // provider runs AFTER descendant effects) so companion reads on the next render route
        // to the host instead of the empty local backend.
        setActiveDevice(dev);
      } catch {
        /* ignore corrupt value */
      }
    };
    if (IN_TAURI) {
      getSetting(KEY).then(parse).catch(() => {});
    } else {
      try {
        parse(localStorage.getItem(KEY));
      } catch {
        /* ignore */
      }
    }
  }, []);

  async function persist(value: string) {
    if (IN_TAURI) await setSetting(KEY, value).catch(() => {});
    else {
      try {
        if (value) localStorage.setItem(KEY, value);
        else localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    }
  }

  const link = async (device: LinkedDevice) => {
    setLinkedMac(device);
    setActiveDevice(device); // eager (see parse) so the first companion read after pairing routes right
    await persist(JSON.stringify(device));
  };
  const unlink = async () => {
    setLinkedMac(null);
    setActiveDevice(null);
    clearSnapshot(); // the persisted index belonged to the now-unlinked host
    await persist("");
  };

  return <DeviceContext.Provider value={{ linkedMac, link, unlink }}>{children}</DeviceContext.Provider>;
}

export function useLinkedDevice() {
  return useContext(DeviceContext);
}
