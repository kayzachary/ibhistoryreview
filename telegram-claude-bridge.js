const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
require("dotenv").config();

// === CONFIGURATION ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map(Number)
  : []; // Empty = allow all (set your Telegram user ID for security)

if (!TELEGRAM_BOT_TOKEN) {
  console.error(
    "Error: Set TELEGRAM_BOT_TOKEN in .env file or environment variable."
  );
  console.error("Get one from @BotFather on Telegram.");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const activeSessions = new Map(); // chatId -> child process

function isAuthorized(userId) {
  return ALLOWED_USER_IDS.length === 0 || ALLOWED_USER_IDS.includes(userId);
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Claude Code Telegram Bridge\n\n" +
      "Send any message and it will be forwarded to Claude Code running on your machine.\n\n" +
      "Commands:\n" +
      "/start - Show this help\n" +
      "/stop - Cancel the current running command\n" +
      "/id - Show your Telegram user ID (for ALLOWED_USER_IDS)"
  );
});

bot.onText(/\/id/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your Telegram user ID: ${msg.from.id}`);
});

bot.onText(/\/stop/, (msg) => {
  const session = activeSessions.get(msg.chat.id);
  if (session) {
    session.kill("SIGTERM");
    activeSessions.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, "Stopped current command.");
  } else {
    bot.sendMessage(msg.chat.id, "No active command to stop.");
  }
});

bot.on("message", (msg) => {
  // Skip command messages
  if (
    msg.text &&
    (msg.text.startsWith("/start") ||
      msg.text.startsWith("/stop") ||
      msg.text.startsWith("/id"))
  ) {
    return;
  }

  if (!msg.text) return;

  if (!isAuthorized(msg.from.id)) {
    bot.sendMessage(msg.chat.id, "Unauthorized. Your ID: " + msg.from.id);
    return;
  }

  const chatId = msg.chat.id;

  // Kill any existing session for this chat
  if (activeSessions.has(chatId)) {
    activeSessions.get(chatId).kill("SIGTERM");
    activeSessions.delete(chatId);
  }

  bot.sendMessage(chatId, "Running...");

  // Spawn claude CLI in non-interactive print mode
  const claude = spawn("claude", ["-p", msg.text], {
    cwd: process.env.CLAUDE_WORKING_DIR || process.cwd(),
    env: { ...process.env },
    timeout: 300000, // 5 minute timeout
  });

  activeSessions.set(chatId, claude);

  let output = "";
  let errorOutput = "";

  claude.stdout.on("data", (data) => {
    output += data.toString();
  });

  claude.stderr.on("data", (data) => {
    errorOutput += data.toString();
  });

  claude.on("close", (code) => {
    activeSessions.delete(chatId);

    const response = output.trim() || errorOutput.trim() || "(no output)";

    // Telegram messages have a 4096 char limit — split if needed
    const chunks = splitMessage(response, 4000);
    for (const chunk of chunks) {
      bot.sendMessage(chatId, chunk);
    }
  });

  claude.on("error", (err) => {
    activeSessions.delete(chatId);
    bot.sendMessage(chatId, `Error: ${err.message}`);
  });
});

function splitMessage(text, maxLen) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLen) {
      chunks.push(text);
      break;
    }
    // Try to split at a newline
    let splitIdx = text.lastIndexOf("\n", maxLen);
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = maxLen;
    }
    chunks.push(text.slice(0, splitIdx));
    text = text.slice(splitIdx).trimStart();
  }
  return chunks;
}

console.log("Telegram-Claude bridge is running!");
console.log("Send a message to your bot on Telegram to get started.");
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});
