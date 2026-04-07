const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const crypto = require("crypto");
require("dotenv").config();

// === CONFIGURATION ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map(Number)
  : [];

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Error: Set TELEGRAM_BOT_TOKEN in .env file or environment variable.");
  console.error("Get one from @BotFather on Telegram.");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// chatId -> { activeTasks: Map<taskId, {process, prompt}>, conversationActive: bool }
const chatState = new Map();
let taskCounter = 0;

function isAuthorized(userId) {
  return ALLOWED_USER_IDS.length === 0 || ALLOWED_USER_IDS.includes(userId);
}

function getChat(chatId) {
  if (!chatState.has(chatId)) {
    chatState.set(chatId, {
      activeTasks: new Map(),
      conversationActive: false,
    });
  }
  return chatState.get(chatId);
}

// === COMMANDS ===

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Claude Code Telegram Bridge\n\n" +
      "Messages are sent to Claude with conversation memory — it remembers what you talked about.\n\n" +
      "Commands:\n" +
      "/start - Show this help\n" +
      "/new - Start a fresh conversation (clears memory)\n" +
      "/btw <message> - Quick side query (separate from main conversation)\n" +
      "/tasks - Show all running tasks\n" +
      "/stop - Stop all running tasks\n" +
      "/stop <id> - Stop a specific task by ID\n" +
      "/id - Show your Telegram user ID"
  );
});

bot.onText(/\/id/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your Telegram user ID: ${msg.from.id}`);
});

bot.onText(/\/new/, (msg) => {
  const chat = getChat(msg.chat.id);
  chat.conversationActive = false;
  bot.sendMessage(msg.chat.id, "Conversation cleared. Next message starts fresh.");
});

bot.onText(/\/tasks/, (msg) => {
  const chat = getChat(msg.chat.id);
  if (chat.activeTasks.size === 0) {
    bot.sendMessage(msg.chat.id, "No tasks running.");
    return;
  }
  let list = "Running tasks:\n\n";
  for (const [id, task] of chat.activeTasks) {
    const preview = task.prompt.length > 60 ? task.prompt.slice(0, 60) + "..." : task.prompt;
    list += `#${id} — ${preview}\n`;
  }
  bot.sendMessage(msg.chat.id, list);
});

bot.onText(/\/stop(.*)/, (msg, match) => {
  const arg = match[1].trim();
  const chat = getChat(msg.chat.id);

  if (arg) {
    const id = parseInt(arg.replace("#", ""), 10);
    const task = chat.activeTasks.get(id);
    if (task) {
      task.process.kill("SIGTERM");
      chat.activeTasks.delete(id);
      bot.sendMessage(msg.chat.id, `Stopped task #${id}.`);
    } else {
      bot.sendMessage(msg.chat.id, `Task #${id} not found. Use /tasks to see running tasks.`);
    }
  } else {
    if (chat.activeTasks.size === 0) {
      bot.sendMessage(msg.chat.id, "No tasks running.");
      return;
    }
    const count = chat.activeTasks.size;
    for (const [id, task] of chat.activeTasks) {
      task.process.kill("SIGTERM");
    }
    chat.activeTasks.clear();
    bot.sendMessage(msg.chat.id, `Stopped ${count} task(s).`);
  }
});

// /btw — standalone side query, no conversation memory
bot.onText(/\/btw (.+)/, (msg, match) => {
  if (!isAuthorized(msg.from.id)) {
    bot.sendMessage(msg.chat.id, "Unauthorized. Your ID: " + msg.from.id);
    return;
  }
  runCommand(msg.chat.id, match[1], "btw");
});

// Main message handler
bot.on("message", (msg) => {
  if (
    msg.text &&
    (msg.text.startsWith("/start") ||
      msg.text.startsWith("/stop") ||
      msg.text.startsWith("/tasks") ||
      msg.text.startsWith("/btw") ||
      msg.text.startsWith("/new") ||
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
  const chat = getChat(chatId);
  const taskId = ++taskCounter;
  const tag = label === "btw" ? `BTW #${taskId}` : `Task #${taskId}`;

  bot.sendMessage(chatId, `${tag} started: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);

  const claudePath = process.env.CLAUDE_PATH || "/opt/node22/bin/claude";
  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();

  // Build args:
  // - Main conversation messages use --continue to keep conversation history
  // - /btw messages are standalone (no --continue)
  const args = ["-p", prompt];

  if (label === "task" && chat.conversationActive) {
    // Continue existing conversation
    args.push("--continue");
  }

  const claude = spawn(claudePath, args, {
    cwd,
    env: { ...process.env, PATH: process.env.PATH + ":/opt/node22/bin:/usr/local/bin" },
    timeout: 300000,
  });

  chat.activeTasks.set(taskId, { process: claude, prompt });

  // After first successful main conversation message, mark conversation as active
  if (label === "task") {
    chat.conversationActive = true;
  }

  let output = "";
  let errorOutput = "";

  claude.stdout.on("data", (data) => {
    output += data.toString();
  });

  claude.stderr.on("data", (data) => {
    errorOutput += data.toString();
  });

  claude.on("close", (code) => {
    chat.activeTasks.delete(taskId);

    let response;
    if (output.trim()) {
      response = output.trim();
    } else if (errorOutput.trim()) {
      response = "Error:\n" + errorOutput.trim();
    } else {
      response = `(no output — exit code ${code})`;
    }
    const header = `${tag} finished:\n\n`;

    const chunks = splitMessage(header + response, 4000);
    for (const chunk of chunks) {
      bot.sendMessage(chatId, chunk);
    }
  });

  claude.on("error", (err) => {
    chat.activeTasks.delete(taskId);
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
