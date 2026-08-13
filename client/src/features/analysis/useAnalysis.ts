import { useEffect, useState } from "react";
import type { AnalysisRecord } from "./analysis";
import { fetchAnalysis } from "./analysis";

export type AnalysisState =
  | { status: "loading"; record?: undefined; error?: undefined }
  | { status: "ready"; record: AnalysisRecord; error?: undefined }
  | { status: "error"; record?: undefined; error: string };

/**
 * Load per-turbine numbers for a scene request.
 *
 * Keyed on the serialised request, exactly as `useVelocityField` is, so a bearing change
 * invalidates the numbers and the volume together. A failure is surfaced rather than
 * swallowed: the panel's job is to state figures, and silently keeping stale ones beside a
 * newly rendered field would be worse than showing nothing.
 */
export function useAnalysis(request: unknown, url = "/api/analysis"): AnalysisState {
  const [state, setState] = useState<AnalysisState>({ status: "loading" });
  // Null until the scene has loaded. Sending it anyway posts a JSON `null`, which the server
  // correctly rejects as a malformed scene — so the panel would show a validation error about
  // a request the user never made, for the second or two before the real one arrives.
  const requestBody = request === null || request === undefined ? "" : JSON.stringify(request);
  useEffect(() => {
    if (!requestBody) {
      setState({ status: "loading" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchAnalysis(JSON.parse(requestBody) as unknown, controller.signal, url)
      .then((record) => setState({ status: "ready", record }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "Could not load turbine analysis",
        });
      });
    return () => controller.abort();
  }, [requestBody, url]);
  return state;
}
