import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * NicotinD #551: the bgutil plugin baked into an addon image must match the
 * provider server it talks to, or the service starts and YouTube downloads
 * quietly stop working. The server's version is published *on the artifact* —
 * a label on the provider image — so a repo that cannot read this one (the
 * spotdl addon) can still inspect it. This test pins that contract, and, now
 * that the server is built here (NicotinD #1315), the pairing with this
 * addon's own plugin pin, which used to be unguarded.
 */
const root = resolve(import.meta.dir, "..");
const providerDockerfile = readFileSync(resolve(root, "pot-provider/Dockerfile"), "utf8");
const addonDockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");

export const BGUTIL_LABEL = "org.nicotind.bgutil.version";

const pinOf = (dockerfile: string) => dockerfile.match(/^ARG BGUTIL_VERSION=(\S+)/m)?.[1];

describe("pot-provider publishes its bgutil version (NicotinD #551)", () => {
  it("declares an ARG default that the build can be pinned to", () => {
    expect(providerDockerfile).toMatch(/^ARG BGUTIL_VERSION=\S+/m);
  });

  it(`labels the final image with ${BGUTIL_LABEL}`, () => {
    expect(providerDockerfile).toContain(BGUTIL_LABEL);
  });

  it("wires the label to the ARG rather than repeating the literal", () => {
    // A hardcoded label is worse than none: it would keep reporting the old
    // version after a bump, so every consumer's check passes against a lie.
    const label = providerDockerfile.match(new RegExp(`${BGUTIL_LABEL}="([^"]*)"`))?.[1];
    expect(label).toBe("${BGUTIL_VERSION}");
  });

  it("re-declares the ARG in the stage that uses it", () => {
    // A top-level ARG is out of scope inside a stage; without redeclaring, the
    // label silently interpolates to an empty string.
    const finalStage = providerDockerfile.slice(providerDockerfile.lastIndexOf("FROM "));
    expect(finalStage).toMatch(/^ARG BGUTIL_VERSION\s*$/m);
  });
});

describe("the addon's bgutil plugin pairs with the provider server", () => {
  it("pins the same BGUTIL_VERSION in both Dockerfiles", () => {
    const provider = pinOf(providerDockerfile);
    expect(provider).toBeDefined();
    expect(pinOf(addonDockerfile)).toBe(provider);
  });
});
