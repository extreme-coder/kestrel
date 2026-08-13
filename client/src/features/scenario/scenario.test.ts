import { SceneRejected, importSceneFile, validateScene } from "./scenario";

/** A File whose `text()` resolves, since jsdom's File does not implement it. */
function file(name: string, contents: string): File {
  return { name, text: async () => contents } as unknown as File;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateScene", () => {
  it("returns the validated scene and the field request it lowers onto", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ valid: true, scene: { id: "s" }, field_request: {}, summary: {} }), {
          status: 200,
        }),
      ),
    );
    const result = await validateScene({ id: "s" });
    expect(result.valid).toBe(true);
  });

  it("carries every issue path so the user can be told what to fix", async () => {
    // The reason validation is a round trip at all: a bad import has to fail as a list of
    // paths, not as one message about a file with several problems.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "invalid_scene",
            message: "that scene could not be loaded",
            issues: [
              { path: "wind.bearing_deg", message: "expected number" },
              { path: "layout", message: "supply either layout.turbines, or both rows and columns" },
            ],
          }),
          { status: 400 },
        ),
      ),
    );
    await expect(validateScene({})).rejects.toBeInstanceOf(SceneRejected);
    try {
      await validateScene({});
    } catch (error) {
      const rejected = error as SceneRejected;
      expect(rejected.issues.map((issue) => issue.path)).toEqual(["wind.bearing_deg", "layout"]);
    }
  });

  it("carries the list of things that do exist when a name is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ message: 'no bundled site with id "ben-nevis"', available: ["askervein-copernicus-glo30"] }),
          { status: 400 },
        ),
      ),
    );
    try {
      await validateScene({})
    } catch (error) {
      expect((error as SceneRejected).available).toContain("askervein-copernicus-glo30");
    }
  });

  it("survives an error body that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    await expect(validateScene({})).rejects.toBeInstanceOf(SceneRejected);
  });
});

describe("importSceneFile", () => {
  it("reports a syntax error against the file rather than sending it onward", async () => {
    // Caught in the browser on purpose: a JSON syntax error is about the file, and the server
    // could only ever answer "not valid JSON" without saying where.
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    await expect(importSceneFile(file("broken.json", "{ not json"))).rejects.toBeInstanceOf(SceneRejected);
    expect(send).not.toHaveBeenCalled();
    try {
      await importSceneFile(file("broken.json", "{ not json"));
    } catch (error) {
      expect((error as SceneRejected).message).toContain("broken.json");
    }
  });

  it("validates a well-formed file on the server", async () => {
    const send = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(JSON.stringify({ valid: true, scene: {}, field_request: {}, summary: {}, url: String(input) }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", send);
    await importSceneFile(file("mine.json", JSON.stringify({ kestrel_scene: 1 })));
    // There is exactly one validator, and it is not in the browser. A second copy of the
    // rules here would be a second opinion about what a valid scene is.
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.lastCall?.[0])).toContain("/api/scenes/validate");
  });
});
