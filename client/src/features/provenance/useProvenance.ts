import { useEffect, useState } from "react";
import type { ProvenanceRecord } from "./provenance";
import { fetchProvenance } from "./provenance";

export type ProvenanceState =
  | { status: "loading"; record?: undefined; error?: undefined }
  | { status: "ready"; record: ProvenanceRecord; error?: undefined }
  | { status: "error"; record?: undefined; error: string };

/**
 * Load the provenance record once per session.
 *
 * A failure here is reported rather than swallowed. Hiding the disclosure because its
 * request failed would leave the numbers on screen with nothing qualifying them, which is
 * the exact state this feature exists to prevent.
 */
export function useProvenance(url = "/api/provenance"): ProvenanceState {
  const [state, setState] = useState<ProvenanceState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchProvenance(controller.signal, url)
      .then((record) => setState({ status: "ready", record }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "Could not load model provenance",
        });
      });
    return () => controller.abort();
  }, [url]);
  return state;
}
