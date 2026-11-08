import { describe, expect, it } from "bun:test";
import { listenAddress } from "./listen.js";

// NicotinD #1741: the addon always bound every interface. A same-host core only
// needs loopback, so bare metal can now keep it off the LAN.
describe("listenAddress", () => {
  it("binds every interface by default, as the Docker port mapping needs", () => {
    expect(listenAddress({})).toEqual({ hostname: "0.0.0.0", port: 8586 });
  });

  it("takes YTDLP_ADDON_HOST and YTDLP_ADDON_PORT", () => {
    expect(listenAddress({ YTDLP_ADDON_HOST: "127.0.0.1", YTDLP_ADDON_PORT: "9000" })).toEqual({
      hostname: "127.0.0.1",
      port: 9000,
    });
  });
});
