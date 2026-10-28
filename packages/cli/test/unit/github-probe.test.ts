import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/model.js";
import {
  observeFromApi,
  type FetchLike,
  type FetchResponse,
} from "../../src/doctor/github.js";
import { parseRemote, parseRepo } from "../../src/doctor/probe.js";
import { createForgeProbe } from "../../src/seams/forge-probe.js";

const PROBE = fileURLToPath(new URL("../fixtures/probe/", import.meta.url));

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(PROBE, name), "utf8")) as unknown;
}

function response(status: number, body: unknown): FetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeFetch(routes: Record<string, unknown | number>): FetchLike {
  return async (input) => {
    const pathname = new URL(input).pathname;
    const route = routes[pathname];
    if (route === undefined) return response(404, { message: "Not Found" });
    if (typeof route === "number") return response(route, { message: `status ${route}` });
    return response(200, route);
  };
}

const TARGET = { owner: "o", name: "r", token: "t" };

describe("observeFromApi (spec §9.3)", () => {
  it("reads a ruleset as the protection mechanism, with app pinning and bypass actors", async () => {
    const observation = await observeFromApi(
      fakeFetch({
        "/repos/o/r": await fixture("repo.json"),
        "/repos/o/r/rulesets": await fixture("rulesets.json"),
        "/repos/o/r/rulesets/1": await fixture("ruleset-1.json"),
      }),
      TARGET,
    );

    expect(observation).toMatchObject({
      available: true,
      protection: {
        mechanism: "ruleset",
        requiredContexts: [{ context: "invariant-verdict", appId: 15368 }],
        codeOwnerReview: true,
        mergeQueue: "unknown",
      },
    });
    expect(observation.available && observation.protection.bypassActors).toEqual([
      { type: "DeployKey", id: null, mode: "always" },
    ]);
  });

  it("prefers classic branch protection when it carries the check, and reads app_id", async () => {
    const observation = await observeFromApi(
      fakeFetch({
        "/repos/o/r": await fixture("repo.json"),
        "/repos/o/r/rulesets": [],
        "/repos/o/r/branches/main/protection": await fixture("branch-protection.json"),
      }),
      TARGET,
    );

    expect(observation).toMatchObject({
      available: true,
      protection: {
        mechanism: "branch-protection",
        requiredContexts: [{ context: "invariant-verdict", appId: 15368 }],
        codeOwnerReview: true,
      },
    });
  });

  it("ignores a ruleset that does not target the default branch or is not enforced", async () => {
    const observation = await observeFromApi(
      fakeFetch({
        "/repos/o/r": await fixture("repo.json"),
        "/repos/o/r/rulesets": [
          { id: 1, target: "branch", enforcement: "evaluate" },
          { id: 2, target: "branch", enforcement: "active" },
        ],
        "/repos/o/r/rulesets/2": {
          target: "branch",
          enforcement: "active",
          conditions: { ref_name: { include: ["release/*"] } },
          rules: [],
          bypass_actors: [],
        },
      }),
      TARGET,
    );

    expect(observation).toMatchObject({
      available: true,
      protection: { mechanism: "none", requiredContexts: [], codeOwnerReview: false },
    });
  });

  it("reports available: false with a reason when the token is missing or the API returns 403", async () => {
    expect(await observeFromApi(fakeFetch({}), { ...TARGET, token: null })).toMatchObject({
      available: false,
      reason: expect.stringContaining("no token"),
    });
    expect(
      await observeFromApi(fakeFetch({ "/repos/o/r": 403 }), TARGET),
    ).toMatchObject({
      available: false,
      reason: expect.stringContaining("403"),
    });
  });

  it("reports merge queue enabled and a thrown fetch as unavailable, never throws", async () => {
    const merged = await observeFromApi(
      fakeFetch({
        "/repos/o/r": await fixture("repo.json"),
        "/repos/o/r/rulesets": await fixture("rulesets.json"),
        "/repos/o/r/rulesets/1": await fixture("ruleset-merge-queue.json"),
      }),
      TARGET,
    );
    expect(merged).toMatchObject({
      available: true,
      protection: { mechanism: "ruleset", mergeQueue: "enabled" },
    });

    const thrown: FetchLike = async () => {
      throw new Error("network down");
    };
    expect(await observeFromApi(thrown, TARGET)).toMatchObject({
      available: false,
      reason: expect.stringContaining("network down"),
    });
  });

  it("turns classic enforce_admins: false into an admin bypass actor", async () => {
    const observation = await observeFromApi(
      fakeFetch({
        "/repos/o/r": await fixture("repo.json"),
        "/repos/o/r/rulesets": [],
        "/repos/o/r/branches/main/protection": {
          required_status_checks: { checks: [{ context: "invariant-verdict", app_id: 15368 }] },
          required_pull_request_reviews: { require_code_owner_reviews: true },
          enforce_admins: { enabled: false },
        },
      }),
      TARGET,
    );
    expect(observation).toMatchObject({
      available: true,
      protection: {
        mechanism: "branch-protection",
        bypassActors: [{ type: "Admin", id: null, mode: "always" }],
      },
    });
  });
});

describe("createForgeProbe", () => {
  it("returns an unavailable observation when the configured token is absent", async () => {
    const name = "INVARIANT_TEST_DOCTOR_TOKEN";
    const previous = process.env[name];
    delete process.env[name];
    try {
      const config = {
        ...DEFAULT_CONFIG,
        doctor: { ...DEFAULT_CONFIG.doctor, tokenEnv: name },
      };
      expect(await createForgeProbe(config).observe(".")).toMatchObject({
        available: false,
        reason: expect.stringContaining("no token"),
      });
    } finally {
      if (previous !== undefined) process.env[name] = previous;
    }
  });
});

describe("repository identity", () => {
  it("parses GITHUB_REPOSITORY and the common origin URL forms", () => {
    expect(parseRepo("o/r")).toEqual({ owner: "o", name: "r" });
    expect(parseRepo("o")).toBeNull();
    expect(parseRepo("o/r/x")).toBeNull();
    expect(parseRemote("git@github.com:o/r.git")).toEqual({ owner: "o", name: "r" });
    expect(parseRemote("https://github.com/o/r.git")).toEqual({ owner: "o", name: "r" });
    expect(parseRemote("ssh://git@github.com/o/r.git")).toEqual({ owner: "o", name: "r" });
    expect(parseRemote("not a remote")).toBeNull();
  });
});
