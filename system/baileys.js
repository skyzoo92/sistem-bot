const fs = require("fs");
const pino = require("pino");
const chalk = require("chalk");
const readline = require("readline");
const EventEmitter = require("events");
const { Boom } = require("@hapi/boom");

const simple = require("./simple");
const {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require("@kelvdra/bails");

const { smsg } = require("./serialize"); // kalau kamu punya helper smsg

class BaileysBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.store = config.store || {};
    this.version = config.version || [2, 3000, 1015901307];
    this.browsers = config.browsers || ["Ubuntu", "Chrome", "20.0.04"];
    this.name = config.name || "raptalia";
    this.sessionsName = config.sessions_name || "sessions";
    this.pairing = config.pairing_code || false;
  }

  async init() {
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionsName);

    const connectionOptions = {
      printQRInTerminal: !this.pairing,
      syncFullHistory: true,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      patchMessageBeforeSending: (message) => {
        const requiresPatch = !!(
          message.buttonsMessage ||
          message.templateMessage ||
          message.listMessage
        );
        if (requiresPatch) {
          message = {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadataVersion: 2,
                  deviceListMetadata: {},
                },
                ...message,
              },
            },
          };
        }
        return message;
      },
      browser: this.browsers,
      logger: pino({ level: "fatal" }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino().child({ level: "silent", stream: "store" })
        ),
      },
    };

    this.conn = simple.makeWASocket(connectionOptions);
    this.conn.isInit = false;

    // === Pairing Mode ===
    if (this.pairing && !this.conn.authState.creds.registered) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const question = (text) =>
        new Promise((resolve) => rl.question(text, resolve));

      let phoneNumber = "";
      do {
        phoneNumber = await question(
          "ex: 628xxx...\n\nEnter your number (must start with 62): "
        );
      } while (!/^\d{10,15}$/.test(phoneNumber) || !phoneNumber.startsWith("62"));

      try {
        const code = await this.conn.requestPairingCode(phoneNumber, this.name);
        console.log(
          `✅ Your pairing code: ${code?.match(/.{1,4}/g)?.join("-") || code}`
        );
      } catch (err) {
        console.error("❌ Failed to get pairing code:", err);
      }
    }

    // === Event Listeners ===
    this.conn.ev.on("creds.update", saveCreds);

    this.conn.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "close") {
        const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
        console.log(chalk.red("❌ Connection closed"), lastDisconnect?.error);

        if (reason === DisconnectReason.badSession) {
          console.log("Bad Session File, delete session and try again.");
          process.exit(0);
        } else if (reason === DisconnectReason.connectionClosed) {
          console.log("Connection closed, reconnecting...");
          await this.init();
        } else if (reason === DisconnectReason.connectionLost) {
          console.log("Connection lost, reconnecting...");
          await this.init();
        } else if (reason === DisconnectReason.connectionReplaced) {
          console.log("Connection replaced, logging out.");
          this.conn.logout();
        } else if (reason === DisconnectReason.loggedOut) {
          console.log("Device logged out.");
          this.conn.logout();
        } else if (reason === DisconnectReason.restartRequired) {
          console.log("Restart required, restarting...");
          await this.init();
        } else if (reason === DisconnectReason.timedOut) {
          console.log("Connection timed out, reconnecting...");
          await this.init();
        }
      } else if (connection === "connecting") {
        console.log("⏳ Connecting...");
      } else if (connection === "open") {
        console.log("✅ Bot connected.");
      }
    });

    this.conn.ev.on("contacts.update", (update) => {
      for (let contact of update) {
        let id = this.conn.decodeJid(contact.id);
        this.store.contacts = this.store.contacts || {};
        this.store.contacts[id] = {
          ...(this.store.contacts?.[id] || {}),
          ...(contact || {}),
        };
      }
    });

    this.conn.ev.on("contacts.upsert", (update) => {
      for (let contact of update) {
        let id = this.conn.decodeJid(contact.id);
        this.store.contacts = this.store.contacts || {};
        this.store.contacts[id] = { ...(contact || {}), isContact: true };
      }
    });

    this.conn.ev.on("groups.update", (updates) => {
      for (const update of updates) {
        const id = update.id;
        this.store.groupMetadata = this.store.groupMetadata || {};
        this.store.groupMetadata[id] = {
          ...(this.store.groupMetadata[id] || {}),
          ...(update || {}),
        };
      }
    });

    this.conn.ev.on("group-participants.update", async ({ id, participants, action }) => {
      const metadata = this.store.groupMetadata?.[id];
      if (metadata) {
        switch (action) {
          case "add":
            metadata.participants.push(
              ...participants.map((id) => ({
                id: this.conn.decodeJid(id),
                admin: null,
              }))
            );
            this.emit("group.welcome", {
              member: participants,
              jid: id,
              subject: await this.conn.getName(id),
            });
            break;
          case "remove":
            metadata.participants = metadata.participants.filter(
              (p) => !participants.includes(this.conn.decodeJid(p.id))
            );
            this.emit("group.remove", {
              member: participants,
              jid: id,
              subject: await this.conn.getName(id),
            });
            break;
          case "promote":
          case "demote":
            for (const participant of metadata.participants) {
              let jid = this.conn.decodeJid(participant.id);
              if (participants.includes(jid)) {
                participant.admin = action === "promote" ? "admin" : null;
              }
            }
            this.emit(action === "promote" ? "group.promote" : "group.demote", {
              member: participants,
              jid: id,
              subject: await this.conn.getName(id),
            });
            break;
        }
      }
    });

    this.conn.ev.on("messages.upsert", async (cht) => {
      if (cht.messages.length === 0) return;
      const chatUpdate = cht.messages[0];
      if (!chatUpdate.message) return;

      chatUpdate.message =
        Object.keys(chatUpdate.message)[0] === "ephemeralMessage"
          ? chatUpdate.message.ephemeralMessage.message
          : chatUpdate.message;

      let m = await smsg(chatUpdate, this.conn, this.store);

      if (m.isBaileys) return;

      if (Object.keys(this.store.groupMetadata || {}).length === 0) {
        this.store.groupMetadata = await this.conn.groupFetchAllParticipating();
      }

      this.emit("msg.notify", {
        message: m,
        conn: this.conn,
        store: this.store,
        update: chatUpdate,
      });
    });

    this.conn.ev.on("call", (update) => {
      this.emit("call", update);
    });

    return this.conn;
  }

  async login() {
    await this.init();
  }
}

module.exports = BaileysBot;
