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

// chatId -> Map<taskId, { process, prompt }>
const activeSessions = new Map();
let taskCounter = 0;

function isAuthorized(userId) {
  return ALLOWED_USER_IDS.length === 0 || ALLOWED_USER_IDS.includes(userId);
}

function getSessionMap(chatId) {
  if (!activeSessions.has(chatId)) {
    activeSessions.set(chatId, new Map());
  }
  return activeSessions.get(chatId);
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Claude Code Telegram Bridge\n\n" +
      "Send any message and it will be forwarded to Claude Code running on your machine.\n\n" +
      "Multiple commands run in parallel — send as many as you want!\n\n" +
      "Commands:\n" +
      "/start - Show this help\n" +
      "/btw <message> - Quick side query while others are running\n" +
      "/tasks - Show all running tasks\n" +
      "/stop - Stop all running tasks\n" +
      "/stop <id> - Stop a specific task by ID\n" +
      "/id - Show your Telegram user ID"
  );
});

bot.onText(/\/id/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your Telegram user ID: ${msg.from.id}`);
});

bot.onText(/\/tasks/, (msg) => {
  const sessions = getSessionMap(msg.chat.id);
  if (sessions.size === 0) {
    bot.sendMessage(msg.chat.id, "No tasks running.");
    return;
  }
  let list = "Running tasks:\n\n";
  for (const [id, task] of sessions) {
    const preview =
      task.prompt.length > 60
        ? task.prompt.slice(0, 60) + "..."
        : task.prompt;
    list += `#${id} — ${preview}\n`;
  }
  bot.sendMessage(msg.chat.id, list);
});

bot.onText(/\/stop(.*)/, (msg, match) => {
  const arg = match[1].trim();
  const sessions = getSessionMap(msg.chat.id);

  if (arg) {
    // Stop specific task
    const id = parseInt(arg.replace("#", ""), 10);
    const task = sessions.get(id);
    if (task) {
      task.process.kill("SIGTERM");
      sessions.delete(id);
      bot.sendMessage(msg.chat.id, `Stopped task #${id}.`);
    } else {
      bot.sendMessage(
        msg.chat.id,
        `Task #${id} not found. Use /tasks to see running tasks.`
      );
    }
  } else {
    // Stop all
    if (sessions.size === 0) {
      bot.sendMessage(msg.chat.id, "No tasks running.");
      return;
    }
    const count = sessions.size;
    for (const [id, task] of sessions) {
      task.process.kill("SIGTERM");
    }
    sessions.clear();
    bot.sendMessage(msg.chat.id, `Stopped ${count} task(s).`);
  }
});

// /btw handler — quick side query
bot.onText(/\/btw (.+)/, (msg, match) => {
  if (!isAuthorized(msg.from.id)) {
    bot.sendMessage(msg.chat.id, "Unauthorized. Your ID: " + msg.from.id);
    return;
  }
  runCommand(msg.chat.id, match[1], "btw");
});

bot.on("message", (msg) => {
  // Skip command messages
  if (
    msg.text &&
    (msg.text.startsWith("/start") ||
      msg.text.startsWith("/stop") ||
      msg.text.startsWith("/tasks") ||
      msg.text.startsWith("/btw") ||
      msg.text.startsWith("/id"))
  ) {
    return;
  }

  if (!msg.text) return;

  if (!isAuthorized(msg.from.id)) {
    bot.sendMessage(msg.chat.id, "Unauthorized. Your ID: " + msg.from.id);
    return;
  }

  runCommand(msg.chat.id, msg.text, "task");
});

function runCommand(chatId, prompt, label) {
  const sessions = getSessionMap(chatId);
  const taskId = ++taskCounter;

  const tag = label === "btw" ? `BTW #${taskId}` : `Task #${taskId}`;
  bot.sendMessage(chatId, `${tag} started: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);

  const claude = spawn("claude", ["-p", prompt], {
    cwd: process.env.CLAUDE_WORKING_DIR || process.cwd(),
    env: { ...process.env },
    timeout: 300000,
  });

  sessions.set(taskId, { process: claude, prompt });

  let output = "";
  let errorOutput = "";

  claude.stdout.on("data", (data) => {
    output += data.toString();
  });

  claude.stderr.on("data", (data) => {
    errorOutput += data.toString();
  });

  claude.on("close", (code) => {
    sessions.delete(taskId);

    const response = output.trim() || errorOutput.trim() || "(no output)";
    const header = `${tag} finished:\n\n`;

    const chunks = splitMessage(header + response, 4000);
    for (const chunk of chunks) {
      bot.sendMessage(chatId, chunk);
    }
  });

  claude.on("error", (err) => {
    sessions.delete(taskId);
    bot.sendMessage(chatId, `${tag} error: ${err.message}`);
  });
}

function splitMessage(text, maxLen) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLen) {
      chunks.push(text);
      break;
    }
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
