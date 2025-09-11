require("events").setMaxListeners(5000);
const { Boom } = require("@hapi/boom");
const { EventEmitter } = require("events");
const chalk = require("chalk");
const pino = require("pino");
const simple = require("./simple.js");
const { smsg } = require("./serialize");
const readline = require('readline')

class BaileysBot extends EventEmitter {
    constructor(config) {
        super();
        this.conn = null;
        this.store = null;
        this.config = config;
        this.logger = pino({
            timestamp: () => `,"time":"${new Date().toJSON()}"`
        }).child({ class: "Rapthalia" });
        this.logger.level = "fatal";
    }

    question(query) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        return new Promise(resolve => rl.question(query, ans => {
            rl.close();
            resolve(ans);
        }));
    }

    async system() {
        const { state, saveCreds } = await this.config.baileys.useMultiFileAuthState(
            this.config.sessions ? this.config.sessions : "Rapthalia-sessions"
        );

        this.conn = simple.makeWASocket({
            logger: pino({ level: "silent" }),
            printQRInTerminal: !this.config.pairing_code,
            auth: state,
            version: this.config.version ? this.config.version : [2, 3000, 1017531287],
            browser: this.config.browser
                ? this.config.browser
                : this.config.baileys.Browsers.ubuntu("Edge"),
            getMessage: async key => {
                const jid = this.config.baileys.jidNormalizedUser(key.remoteJid);
                const msg = await this.config.store.loadMessage(jid, key.id);
                return msg?.message || '';
            },
            shouldSyncHistoryMessage: msg => {
                return !!msg.syncType;
            },
        }, this.config.baileys);

        this.config.store.bind(this.conn.ev);

        if (this.config.pairing_code && !this.conn.authState.creds.registered) {
            console.log(chalk.red.bold("[ ! ]") + chalk.cyan.bold(" Please enter your WhatsApp number, for example +628xxxx"));
            const phoneNumber = await this.question(chalk.green.bold(`– Your number : `));
            const code = await this.conn.requestPairingCode(phoneNumber);
            setTimeout(() => {
                console.log(chalk.white.bold("- Your Pairing Code : " + code))
            }, 3000);
        }

        //=====[ Connection Update ]=======//
        this.conn.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                console.log(chalk.green.bold(lastDisconnect.error));
                if (lastDisconnect.error == 'Error: Stream Errored (unknown)') {
                    process.exit(0);
                } else if (reason === this.config.baileys.DisconnectReason.badSession) {
                    console.log(chalk.yellow.bold("[ ! ] ") + chalk.red.bold(`Bad Session File, Please Delete Session and Scan Again`));
                    process.exit(0);
                } else if (reason === this.config.baileys.DisconnectReason.connectionClosed) {
                    console.log(chalk.yellow.bold('Connection closed, reconnecting. . .'));
                    process.exit(0);
                } else if (reason === this.config.baileys.DisconnectReason.connectionLost) {
                    console.log(chalk.yellow.bold('Connection lost, trying to reconnect'));
                    process.exit(0);
                } else if (reason === this.config.baileys.DisconnectReason.connectionReplaced) {
                    console.log(chalk.green.bold('Connection Replaced, Another New Session Opened, Please Close Current Session First'));
                    this.conn.logout();
                } else if (reason === this.config.baileys.DisconnectReason.loggedOut) {
                    console.log(chalk.yellow.bold("[ ! ] ") + chalk.red.bold(`Device Logged Out, Please Scan Again And Run.`));
                    this.conn.logout();
                } else if (reason === this.config.baileys.DisconnectReason.restartRequired) {
                    console.log(chalk.green.bold('Restart Required, Restarting. . .'));
                    await this.system();
                } else if (reason === this.config.baileys.DisconnectReason.timedOut) {
                    console.log(chalk.green.bold('Connection TimedOut, Reconnecting. . .'));
                    await this.system();
                }
            } else if (connection === "connecting") {
                console.log(chalk.green.bold('Connecting, Please Be Patient. . .'));
            } else if (connection === "open") {
                console.log(chalk.green.bold('Bot Successfully Connected. . . .'));
            }
        });

        this.conn.ev.on('creds.update', saveCreds);

        //=====[ Contacts Update ]========//
        this.conn.ev.on('contacts.update', update => {
            for (let contact of update) {
                let id = this.config.baileys.jidNormalizedUser(contact.id);
                if (this.config.store && this.config.store.contacts) {
                    this.config.store.contacts[id] = {
                        ...(this.config.store.contacts?.[id] || {}),
                        ...(contact || {})
                    };
                }
            }
        });

        this.conn.ev.on('contacts.upsert', update => {
            for (let contact of update) {
                let id = this.config.baileys.jidNormalizedUser(contact.id);
                if (this.config.store && this.config.store.contacts) {
                    this.config.store.contacts[id] = { ...(contact || {}), isContact: true };
                }
            }
        });

        this.conn.ev.on('groups.update', updates => {
            for (const update of updates) {
                const id = update.id;
                if (this.config.store.groupMetadata[id]) {
                    this.config.store.groupMetadata[id] = {
                        ...(this.config.store.groupMetadata[id] || {}),
                        ...(update || {})
                    };
                }
            }
        });

        this.conn.ev.on('group-participants.update', async ({ id, participants, action }) => {
            const metadata = this.config.store.groupMetadata[id];
            if (metadata) {
                switch (action) {
                    case 'add':
                    case 'revoked_membership_requests':
                        metadata.participants.push(...participants.map(id => ({
                            id: this.config.baileys.jidNormalizedUser(id),
                            admin: null
                        })));
                        this.emit("group.welcome", {
                            member: participants,
                            jid: id,
                            subject: await this.conn.getName(id)
                        })
                        break;
                    case 'demote':
                    case 'promote':
                        for (const participant of metadata.participants) {
                            let jid = this.config.baileys.jidNormalizedUser(participant.id);
                            if (participants.includes(jid)) {
                                participant.admin = action === 'promote' ? 'admin' : null;
                            }
                        }
                        this.emit(action === "promote" ? "group.promote" : "group.demote", {
                            member: participants,
                            jid: id,
                            subject: await this.conn.getName(id)
                        })
                        break;
                    case 'remove':
                        metadata.participants = metadata.participants.filter(
                            p => !participants.includes(this.config.baileys.jidNormalizedUser(p.id))
                        );
                        this.emit("group.remove", {
                            member: participants,
                            jid: id,
                            subject: await this.conn.getName(id)
                        })
                        break;
                }
            }
        });

        this.conn.ev.on("messages.upsert", async (cht) => {
            if (cht.messages.length === 0) return;
            const chatUpdate = cht.messages[0];
            if (!chatUpdate.message) return;

            chatUpdate.message = (Object.keys(chatUpdate.message)[0] === 'ephemeralMessage')
                ? chatUpdate.message.ephemeralMessage.message
                : chatUpdate.message;

            let m = await smsg(chatUpdate, this.conn, this.config.store, this.config.baileys);

            if (m.isBaileys) return;

            if (Object.keys(this.config.store.groupMetadata).length === 0) {
                this.config.store.groupMetadata = this.conn.groupFetchAllParticipating();
            }

            this.emit("msg.notify", {
                message: m,
                conn: this.conn,
                store: this.config.store,
                update: chatUpdate
            })
        });

        this.conn.ev.on("call", (update) => {
            this.emit("call", update);
        });

        return this.conn;
    }

    async login() {
        await this.system();
    }
}

module.exports = BaileysBot;
