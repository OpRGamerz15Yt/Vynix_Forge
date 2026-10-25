const { Client, Authenticator } = require("minecraft-launcher-core");
const path = require("path");
const os = require("os");

const launcher = new Client();

async function launchMinecraft(config, username) {
  const root = config.minecraft.gameDirectory.replace(
    "%appdata%",
    path.join(os.homedir(), "AppData", "Roaming")
  );

  const opts = {
    authorization: Authenticator.getAuth(username || "Player"),
    root,
    version: {
      number: config.minecraft.version,
      type: "release"
    },
    memory: {
      min: config.minecraft.memory.minGB + "G",
      max: config.minecraft.memory.maxGB + "G"
    },
    window: {
      width: parseInt(config.minecraft.window.resolution.split("x")[0]),
      height: parseInt(config.minecraft.window.resolution.split("x")[1]),
      fullscreen: config.minecraft.window.fullscreen
    },
    customArgs: (config.minecraft.jvmArgs || "").split(" ").filter(Boolean)
  };

  return launcher.launch(opts);
}

module.exports = { launchMinecraft };
