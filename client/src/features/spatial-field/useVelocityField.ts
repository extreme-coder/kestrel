import { useEffect, useState } from "react";
import type { VelocityField } from "./field";
import { parseVelocityField } from "./field";

export type FieldLoadState =
  | { status: "loading"; field?: undefined; error?: undefined }
  | { status: "ready"; field: VelocityField; error?: undefined }
  | { status: "error"; field?: undefined; error: string };

export function useVelocityField(request: unknown, url = "/api/field"): FieldLoadState {
  const [state, setState] = useState<FieldLoadState>({ status: "loading" });
  const requestBody = JSON.stringify(request);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/vnd.kestrel.field" },
      body: requestBody,
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Field request failed (${response.status})`);
      return parseVelocityField(await response.arrayBuffer());
    }).then((field) => setState({ status: "ready", field })).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ status: "error", error: error instanceof Error ? error.message : "Could not load field" });
    });
    return () => controller.abort();
  }, [requestBody, url]);
  return state;
}
