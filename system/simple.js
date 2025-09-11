const { toAudio, toPTT, toVideo } = require("./converter");
const chalk = require("chalk");
const axios = require("axios");
const fetch = require("node-fetch");
const FileType = require("file-type");
const PhoneNumber = require("awesome-phonenumber");
const fs = require("fs");
const path = require("path");
let Jimp = require("jimp");
const pino = require("pino");
const mime = require("mime-types");
const {
  imageToWebp,
  videoToWebp,
  writeExifImg,
  writeExifVid,
} = require("./exif");

const getFile = async (PATH, returnAsFilename) => {
    let res, filename;
    const data = Buffer.isBuffer(PATH)
      ? PATH
      : /^data:.*?\/.*?;base64,/i.test(PATH)
        ? Buffer.from(PATH.split`,`[1], "base64")
        : /^https?:\/\//.test(PATH)
          ? (res = (await axios.get(PATH, { responseType: "arraybuffer" })))
          : fs.existsSync(PATH)
            ? ((filename = PATH), fs.readFileSync(PATH))
            : typeof PATH === "string"
              ? PATH
              : Buffer.alloc(0);
    if (!Buffer.isBuffer(data.data || data)) throw new TypeError("Result is not a buffer");
    const type = res ? {
      mime: res.headers["content-type"], 
      ext: mime.extension(res.headers["content-type"]),
    } : (await FileType.fromBuffer(data)) || {
    mime: "application/bin",
    ext: ".bin"
    }
    if (data && returnAsFilename && !filename)
      (filename = path.join(
        __dirname,
        "../tmp/" + new Date() * 1 + "." + type.ext,
      )),
        await fs.promises.writeFile(filename, data);
    return {
      filename,
      ...type,
      data: data.data ? data.data : data,
      deleteFile() {
        return filename && fs.promises.unlink(filename);
      },
    };
 }
 
exports.makeWASocket = (connectionOptions, config) => {
global.ephemeral = { ephemeralExpiration: config.WA_DEFAULT_EPHEMERAL };
  let conn = config.makeWASocket(
    connectionOptions,
  );
  conn.loadAllMessages = (messageID) => {
    return Object.entries(conn.chats)
      .filter(([_, { messages }]) => typeof messages === "object")
      .find(([_, { messages }]) =>
        Object.entries(messages).find(
          ([k, v]) => k === messageID || v.key?.id === messageID,
        ),
      )?.[1].messages?.[messageID];
  };
  /* conn.groupMetadata = (jid) => {
    return store.groupMetadata[jid]
    }*/
  conn.decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      const decode = config.jidDecode(jid) || {};
      return (
        (decode.user && decode.server && decode.user + "@" + decode.server) ||
        jid
      );
    } else return jid;
  };
  if (conn.user && conn.user.id) conn.user.jid = conn.decodeJid(conn.user.id);
  if (!conn.chats) conn.chats = {};

  function updateNameToDb(contacts) {
    if (!contacts) return;
    for (const contact of contacts) {
      const id = conn.decodeJid(contact.id);
      if (!id) continue;
      let chats = conn.chats[id];
      if (!chats) chats = conn.chats[id] = { id };
      conn.chats[id] = {
        ...chats,
        ...({
          ...contact,
          id,
          ...(id.endsWith("@g.us")
            ? { subject: contact.subject || chats.subject || "" }
            : { name: contact.notify || chats.name || chats.notify || "" }),
        } || {}),
      };
    }
  }

  conn.ev.on("contacts.upsert", updateNameToDb);
  conn.ev.on("groups.update", updateNameToDb);
  conn.ev.on("chats.set", async ({ chats }) => {
    for (const { id, name, readOnly } of chats) {
      id = conn.decodeJid(id);
      if (!id) continue;
      const isGroup = id.endsWith("@g.us");
      let chats = conn.chats[id];
      if (!chats) chats = conn.chats[id] = { id };
      chats.isChats = !readOnly;
      if (name) chats[isGroup ? "subject" : "name"] = name;
      if (isGroup) {
        const metadata = await conn.groupMetadata(id).catch((_) => null);
        if (!metadata) continue;
        chats.subject = name || metadata.subject;
        chats.metadata = metadata;
      }
    }
  });
  conn.ev.on(
    "group-participants.update",
    async function updateParticipantsToDb({ id, participants, action }) {
      id = conn.decodeJid(id);
      if (!(id in conn.chats)) conn.chats[id] = { id };
      conn.chats[id].isChats = true;
      const groupMetadata = await conn.groupMetadata(id).catch((_) => null);
      if (!groupMetadata) return;
      conn.chats[id] = {
        ...conn.chats[id],
        subject: groupMetadata.subject,
        metadata: groupMetadata,
      };
    },
  );

  conn.ev.on(
    "groups.update",
    async function groupUpdatePushToDb(groupsUpdates) {
      for (const update of groupsUpdates) {
        const id = conn.decodeJid(update.id);
        if (!id) continue;
        const isGroup = id.endsWith("@g.us");
        if (!isGroup) continue;
        let chats = conn.chats[id];
        if (!chats) chats = conn.chats[id] = { id };
        chats.isChats = true;
        const metadata = await conn.groupMetadata(id).catch((_) => null);
        if (!metadata) continue;
        chats.subject = metadata.subject;
        chats.metadata = metadata;
      }
    },
  );
  conn.ev.on("chats.upsert", async function chatsUpsertPushToDb(chatsUpsert) {
    console.log({ chatsUpsert });
    const { id, name } = chatsUpsert;
    if (!id) return;
    let chats = (conn.chats[id] = {
      ...conn.chats[id],
      ...chatsUpsert,
      isChats: true,
    });
    const isGroup = id.endsWith("@g.us");
    if (isGroup) {
      const metadata = await conn.groupMetadata(id).catch((_) => null);
      if (metadata) {
        chats.subject = name || metadata.subject;
        chats.metadata = metadata;
      }
      const groups =
        (await conn.groupFetchAllParticipating().catch((_) => ({}))) || {};
      for (const group in groups)
        conn.chats[group] = {
          id: group,
          subject: groups[group].subject,
          isChats: true,
          metadata: groups[group],
        };
    }
  });
  conn.ev.on(
    "presence.update",
    async function presenceUpdatePushToDb({ id, presences }) {
      const sender = Object.keys(presences)[0] || id;
      const _sender = conn.decodeJid(sender);
      const presence = presences[sender]["lastKnownPresence"] || "composing";
      let chats = conn.chats[_sender];
      if (!chats) chats = conn.chats[_sender] = { id: sender };
      chats.presences = presence;
      if (id.endsWith("@g.us")) {
        let chats = conn.chats[id];
        if (!chats) {
          const metadata = await conn.groupMetadata(id).catch((_) => null);
          if (metadata)
            chats = conn.chats[id] = {
              id,
              subject: metadata.subject,
              metadata,
            };
        }
        chats.isChats = true;
      }
    },
  );

  conn.logger = {
    ...conn.logger,
    info(...args) {
      console.log(
        chalk.bold.rgb(
          57,
          183,
          16,
        )(`INFO [${chalk.rgb(255, 255, 255)(new Date())}]:`),
        chalk.cyan(...args),
      );
    },
    error(...args) {
      console.log(
        chalk.bold.rgb(
          247,
          38,
          33,
        )(`ERROR [${chalk.rgb(255, 255, 255)(new Date())}]:`),
        chalk.rgb(255, 38, 0)(...args),
      );
    },
    warn(...args) {
      console.log(
        chalk.bold.rgb(
          239,
          225,
          3,
        )(`WARNING [${chalk.rgb(255, 255, 255)(new Date())}]:`),
        chalk.keyword("orange")(...args),
      );
    },
  };

  conn.appendTextMessage = async (m, text, chatUpdate) => {
    let messages = await config.generateWAMessage(
      m.chat,
      {
        text: text,
        mentions: m.mentions,
      },
      {
        userJid: conn.user.id,
        quoted: m.quoted,
        ...ephemeral,
      },
    );
    messages.key.fromMe = config.areJidsSameUser(m.sender, conn.user.id);
    messages.key.id = m.key.id;
    messages.pushName = m.pushName;
    if (m.isGroup) messages.participant = m.sender;
    let msg = {
      ...chatUpdate,
      messages: [config.proto.WebMessageInfo.fromObject(messages)],
      type: "append",
    };
    conn.ev.emit("messages.upsert", msg);
    return m;
  };

  /**
   * getBuffer hehe
   * @param {fs.PathLike} path
   * @param {Boolean} returnFilename
   */
  conn.getFile = async (PATH, returnAsFilename) => {
    let res, filename;
    const data = Buffer.isBuffer(PATH)
      ? PATH
      : /^data:.*?\/.*?;base64,/i.test(PATH)
        ? Buffer.from(PATH.split`,`[1], "base64")
        : /^https?:\/\//.test(PATH)
          ? await (res = await fetch(PATH)).buffer()
          : fs.existsSync(PATH)
            ? ((filename = PATH), fs.readFileSync(PATH))
            : typeof PATH === "string"
              ? PATH
              : Buffer.alloc(0);
    if (!Buffer.isBuffer(data)) throw new TypeError("Result is not a buffer");
    const type = (await FileType.fromBuffer(data)) || {
      mime: "application/octet-stream",
      ext: ".bin",
    };
    if (data && returnAsFilename && !filename)
      (filename = path.join(
        __dirname,
        "../tmp/" + new Date() * 1 + "." + type.ext,
      )),
        await fs.promises.writeFile(filename, data);
    return {
      res,
      filename,
      ...type,
      data,
      deleteFile() {
        return filename && fs.promises.unlink(filename);
      },
    };
  };

  /**
   * waitEvent
   * @param {Partial<BaileysEventMap>|String} eventName
   * @param {Boolean} is
   * @param {Number} maxTries
   * @returns
   */
  conn.waitEvent = (eventName, is = () => true, maxTries = 25) => {
    return new Promise((resolve, reject) => {
      let tries = 0;
      let on = (...args) => {
        if (++tries > maxTries) reject("Max tries reached");
        else if (is()) {
          conn.ev.off(eventName, on);
          resolve(...args);
        }
      };
      conn.ev.on(eventName, on);
    });
  };

  conn.delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   *
   * @param {String} text
   * @returns
   */
  conn.filter = (text) => {
    let mati = [
      "q",
      "w",
      "r",
      "t",
      "y",
      "p",
      "s",
      "d",
      "f",
      "g",
      "h",
      "j",
      "k",
      "l",
      "z",
      "x",
      "c",
      "v",
      "b",
      "n",
      "m",
    ];
    if (/[aiueo][aiueo]([qwrtypsdfghjklzxcvbnm])?$/i.test(text))
      return text.substring(text.length - 1);
    else {
      let res = Array.from(text).filter((v) => mati.includes(v));
      let resu = res[res.length - 1];
      for (let huruf of mati) {
        if (text.endsWith(huruf)) {
          resu = res[res.length - 2];
        }
      }
      let misah = text.split(resu);
      return resu + misah[misah.length - 1];
    }
  };

  /**
   * ms to date
   * @param {String} ms
   */
  conn.msToDate = (ms) => {
    let days = Math.floor(ms / (24 * 60 * 60 * 1000));
    let daysms = ms % (24 * 60 * 60 * 1000);
    let hours = Math.floor(daysms / (60 * 60 * 1000));
    let hoursms = ms % (60 * 60 * 1000);
    let minutes = Math.floor(hoursms / (60 * 1000));
    let minutesms = ms % (60 * 1000);
    let sec = Math.floor(minutesms / 1000);
    return days + " Hari " + hours + " Jam " + minutes + " Menit";
    // +minutes+":"+sec;
  };

  /**
   * isi
   */
  conn.rand = async (isi) => {
    return isi[Math.floor(Math.random() * isi.length)];
  };

  /**
   * Send Media All Type
   * @param {String} jid
   * @param {String|Buffer} path
   * @param {Object} quoted
   * @param {Object} options
   */
  conn.sendMedia = async (jid, path, quoted, options = {}) => {
    let { ext, mime, data } = await conn.getFile(path);
    messageType = mime.split("/")[0];
    pase = messageType.replace("application", "document") || messageType;
    return await conn.sendMessage(
      jid,
      { [`${pase}`]: data, mimetype: mime, ...options },
      { quoted: quoted, ...ephemeral },
    );
  };

  (conn.adReply = (
    jid,
    text,
    title = "",
    body = "",
    buffer,
    source = "",
    quoted,
    options,
  ) => {
    let { data } = conn.getFile(buffer, true);
    return conn.sendMessage(
      jid,
      {
        text: text,
        contextInfo: {
          mentionedJid: conn.parseMention(text),
          externalAdReply: {
            showAdAttribution: true,
            mediaType: 1,
            title: title,
            body: body,
            thumbnailUrl: "https://telegra.ph/file/dc229854bebc5fe9ccf01.jpg",
            renderLargerThumbnail: true,
            sourceUrl: source,
          },
        },
      },
      { quoted: quoted, 
     ...options, ...ephemeral },
    );

    enumerable: true;
  }),
    /**
     * Send Media/File with Automatic Type Specifier
     * @param {String} jid
     * @param {String|Buffer} path
     * @param {String} filename
     * @param {String} caption
     * @param {config.proto.WebMessageInfo} quoted
     * @param {Boolean} ptt
     * @param {Object} options
     */
  conn.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
  const buff = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await (res = await fetch(path)).buffer()
          : fs.existsSync(path)
            ? ((filename = path), fs.readFileSync(path))
            : typeof path === "string"
              ? path
              : Buffer.alloc(0);
    let buffer;
    if (options && (options.packname || options.author)) {
      buffer = await writeExifImg(buff, options);
    } else {
      buffer = await imageToWebp(buff);
    }

    return conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted: quoted, ...ephemeral },
    );
  };
conn.sendVideoAsSticker = async (jid, PATH, quoted, options = {}) => {
const buff = Buffer.isBuffer(PATH)
      ? PATH
      : /^data:.*?\/.*?;base64,/i.test(PATH)
        ? Buffer.from(PATH.split`,`[1], "base64")
        : /^https?:\/\//.test(PATH)
          ? await (res = await fetch(PATH)).buffer()
          : fs.existsSync(PATH)
            ? ((filename = PATH), fs.readFileSync(PATH))
            : typeof PATH === "string"
              ? PATH
              : Buffer.alloc(0);

    let buffer;

    if (options && (options.packname || options.author)) {
      buffer = await writeExifVid(buff, options);
    } else {
      buffer = await videoToWebp(buff);
    }

  return conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted: quoted, ...ephemeral },
    );
  };
conn.sendFile = async (jid, media, filename = null, caption = null, quoted = null, options = {}) => {
  let buffer;
  let mimeType;
  let ext;
  let data = await getFile(media);
    buffer = data.data; 
    mimeType = data.mime || 'application/octet-stream'; 
    ext = data.ext || ".tmp"
let isSticker = false
    if (data.ext === "webp") return isSticker = true
 if (options && options.useDocument) {
    return conn.sendMessage(jid, {
      document: buffer,
      fileName: filename || "file." + ext,
      caption: caption,
      mimetype: mimeType,
      ...options
    }, {
      quoted: quoted,
      ...global.ephemeral
    });
  } else if (/image/.test(mimeType) && !isSticker) {
    return conn.sendMessage(jid, {
      image: buffer,
      mimetype: mimeType,
      caption: caption,
      ...options
    }, {
      quoted: quoted, 
      ...global.ephemeral
    });
  } else if (/video/.test(mimeType)) {
    return conn.sendMessage(jid, {
      video: buffer,
      mimetype: mimeType,
      caption: caption,
      ...options
    }, {
      quoted: quoted, 
      ...global.ephemeral
    });
  } else if (/audio/.test(mimeType)) {
    return conn.sendMessage(jid, {
      audio: buffer,
      ...options
    }, {
      quoted: quoted, 
      ...global.ephemeral
    });
  } else if (/webp/.test(mimeType) && isSticker) {
     try {
    return conn.sendVideoAsSticker(jid, buffer, options);
      } catch(e) {
    return conn.sendImageAsSticker(jid, buffer, options);
    }
  } else {
    return conn.sendMessage(jid, {
      document: buffer,
      fileName: filename || "file." + ext,
      mimetype: mimeType,
      caption: caption,
      ...options
    }, {
      quoted: quoted, 
      ...global.ephemeral
    });
  }
};

  conn.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
  const buff = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await (res = await fetch(path)).buffer()
          : fs.existsSync(path)
            ? ((filename = path), fs.readFileSync(path))
            : typeof path === "string"
              ? path
              : Buffer.alloc(0);
    let buffer;
    if (options && (options.packname || options.author)) {
      buffer = await writeExifImg(buff, options);
    } else {
      buffer = await imageToWebp(buff);
    }

    await conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted: quoted, ...ephemeral },
    );
    return buffer;
  };
  conn.sendVideoAsSticker = async (jid, PATH, quoted, options = {}) => {
const buff = Buffer.isBuffer(PATH)
      ? PATH
      : /^data:.*?\/.*?;base64,/i.test(PATH)
        ? Buffer.from(PATH.split`,`[1], "base64")
        : /^https?:\/\//.test(PATH)
          ? await (res = await fetch(PATH)).buffer()
          : fs.existsSync(PATH)
            ? ((filename = PATH), fs.readFileSync(PATH))
            : typeof PATH === "string"
              ? PATH
              : Buffer.alloc(0);

    let buffer;

    if (options && (options.packname || options.author)) {
      buffer = await writeExifVid(buff, options);
    } else {
      buffer = await videoToWebp(buff);
    }

    await conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted: quoted, ...ephemeral },
    );

    return buffer;
  };
  /**
   * Send Contact
   * @param {String} jid
   * @param {String} number
   * @param {String} name
   * @param {Object} quoted
   * @param {Object} options
   */

    /*    (conn.sendList = async (
      jid,
      header,
      footer,
      separate,
      buttons,
      rows,
      quoted,
      options,
    ) => {
      const inputArray = rows.flat();
      const result = inputArray.reduce((acc, curr, index) => {
        if (index % 2 === 1) {
          const [title, rowId, description] = curr[0];
          acc.push({
            title,
            rowId,
            description,
          });
        }
        return acc;
      }, []);
      let teks = result
        .map((v, index) => {
          return `${v.title || ""}\n${v.rowId || ""}\n${v.description || ""}`.trim();
        })
        .filter((v) => v)
        .join("\n\n");
      return conn.sendMessage(
        jid,
        {
          ...options,
          text: teks,
        },
        {
          quoted,
          ...options,
        },
      );
    }),*/
    /**
     * Reply to a message
     * @param {String} jid
     * @param {String|Object} text
     * @param {Object} quoted
     * @param {Object} options
     */
    (conn.reply = (jid, text = "", quoted, options) => {
      return Buffer.isBuffer(text)
        ? conn.sendFile(jid, text, "file", "", quoted, false, options)
        : conn.sendMessage(
            jid,
            { ...options, text, mentions: conn.parseMention(text) },
            {
            quoted: quoted,    
              ...options,
              mentions: conn.parseMention(text),
              ...ephemeral,
            },
          );
    }); 
  conn.resize = async (image, width, height) => {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy
      .resize(width, height)
      .getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
  };

conn.sendCarousel = async (jid, messages, quoted, json = {}, options = {}) => {
  let cards = [];

  for (let [body, footer, image, button = [], copy = [], url = []] of messages) {
    let file = await conn.getFile(image);
    let mimeType = file.mime.split("/")[0];
    let buttonArray = button.map(i => ({
      name: "quick_reply",
      buttonParamsJson: JSON.stringify({
        display_text: i[0],
        id: i[1]
      })
    }));

    buttonArray.push(
      ...copy.map(i => ({
        name: "cta_copy",
        buttonParamsJson: JSON.stringify({
          display_text: i[0],
          copy_code: i[1]
        })
      }))
    );

    buttonArray.push(
      ...url.map(i => ({
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: i[0],
          url: i[1],
          merBott_url: i[1]
        })
      }))
    );

    let mediaData = await config.prepareWAMessageMedia(
      mimeType === "image"
        ? { image: file.data }
        : mimeType === "video"
        ? { video: file.data }
        : {
            document: file.data,
            mimetype: file.mime,
            fileName: json.filename || "AkiraaBot." + extension(file.mime)
          },
      { upload: conn.waUploadToServer }
    );

    let msg = {
      body: config.proto.Message.InteractiveMessage.Body.create({ text: body }),
      footer: config.proto.Message.InteractiveMessage.Footer.create({ text: footer }),
      header: config.proto.Message.InteractiveMessage.Header.create({
        hasMediaAttachment: true,
        ...mediaData
      }),
      nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: buttonArray
      }),
      ...options,
      contextInfo: {
        mentionedJid: [
          ...conn.parseMention(body),
          ...conn.parseMention(footer)
        ]
      }
    };

    cards.push(msg);
  }

  // Create the carousel message.
  let carouselMessage = generateWAMessageFromContent(
    jid,
    {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2
          },
          interactiveMessage: config.proto.Message.InteractiveMessage.create({
            body: config.proto.Message.InteractiveMessage.Body.create({ text: json.body }),
            footer: config.proto.Message.InteractiveMessage.Footer.create({ text: json.footer }),
            header: config.proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
            carouselMessage: config.proto.Message.InteractiveMessage.CarouselMessage.fromObject({ cards }),
            ...options,
            contextInfo: {
              mentionedJid: [
                ...conn.parseMention(json.body),
                ...conn.parseMention(json.footer)
              ]
            }
          })
        }
      }
    },
    {
      userJid: conn.user.jid,
      quoted: quoted, 
      upload: conn.waUploadToServer,
      ...options
    }
  );

  await conn.relayMessage(jid, carouselMessage.message, { messageId: carouselMessage.key.id });
  return carouselMessage;
};

conn.sendCopy = async (jid, array, quoted, json = {}, options = {}) => {
    const result = [];
    for (const pair of array) {
      const obj = {
        name: "cta_copy",
        buttonParamsJson: JSON.stringify({
          display_text: pair[0],
          copy_code: pair[1],
        }),
      };
      result.push(obj);
    }

    if (json.url) {
        let file = await conn.getFile(json.url);
        let mime = file.mime.split("/")[0];
        let msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                        },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({
                                text: json.body,
                            }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({
                                text: json.footer,
                            }),
                            header: config.proto.Message.InteractiveMessage.Header.create({
                                hasMediaAttachment: true,
                                   ...(await config.prepareWAMessageMedia({
                                ...(file.mime.split("/")[0] === "image" ?  {
                                     image: file.data,
                                                                
                                 } : file.mime.split("/")[0] === "video" ?  {
                                     video: file.data,
                                     
                                 } : {
                                     document: file.data,
                                     mimetype: file.mime,
                                     fileName: json.filename || "AkiraaBot." + extension(file.mime)             
                                 })
                               }, {
                                   upload: conn.waUploadToServer
                               })),
                            }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result,
                            }),
                            ...(options ? options : {
                                contextInfo: {
                                    mentionedJid: [
                                        ...conn.parseMention(json.body),
                                        ...conn.parseMention(json.footer),
                                    ],
                                },
                            }),
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted: quoted, 
                upload: conn.waUploadToServer,
                ...ephemeral,
            },
        );

        return conn.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
        });
    } else {
        let msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                        },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({
                                text: json.body,
                            }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({
                                text: json.footer,
                            }),
                            header: config.proto.Message.InteractiveMessage.Header.create({
                                hasMediaAttachment: false,
                            }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result || [{
                                    text: ""
                                }],
                            }),
                            ...(options ? options : {
                                contextInfo: {
                                    mentionedJid: [
                                        ...conn.parseMention(json.body),
                                        ...conn.parseMention(json.footer),
                                    ],
                                },
                            }),
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted: quoted, 
                upload: conn.waUploadToServer,
                ...ephemeral,
            },
        );
       conn.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
        });
        return msg
    }
  };
  conn.sendUrl = async (jid, array, quoted, json = {}, options = {}) => {
    const result = [];
    for (const pair of array) {
      const obj = {
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: pair[0],
          url: pair[1],
          merBott_url: pair[1],
        }),
      };
      result.push(obj);
    }

        if (json.url) {
        let file = await conn.getFile(json.url);
        let mime = file.mime.split("/")[0];
        let msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                        },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({
                                text: json.body,
                            }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({
                                text: json.footer,
                            }),
                            header: config.proto.Message.InteractiveMessage.Header.create({
                                hasMediaAttachment: true,
                                ...(await config.prepareWAMessageMedia({
                                ...(file.mime.split("/")[0] === "image" ?  {
                                     image: file.data,
                                                                
                                 } : file.mime.split("/")[0] === "video" ?  {
                                     video: file.data,
                                     
                                 } :  {
                                     document: file.data,
                                     mimetype: file.mime,
                                     fileName: json.filename || "AkiraaBot." + extension(file.mime)             
                                 })
                               }, {
                                   upload: conn.waUploadToServer
                               })),
                            }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result,
                            }),
                            ...(options ? options : {
                                contextInfo: {
                                    mentionedJid: [
                                        ...conn.parseMention(json.body),
                                        ...conn.parseMention(json.footer),
                                    ],
                                },
                            }),
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted: quoted, 
                upload: conn.waUploadToServer,
                ...ephemeral,
            },
        );

        return conn.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
        });
    } else {
        let msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                        },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({
                                text: json.body,
                            }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({
                                text: json.footer,
                            }),
                            header: config.proto.Message.InteractiveMessage.Header.create({
                                hasMediaAttachment: false,
                            }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result || [{
                                    text: ""
                                }],
                            }),
                            ...(options ? options : {
                                contextInfo: {
                                    mentionedJid: [
                                        ...conn.parseMention(json.body),
                                        ...conn.parseMention(json.footer),
                                    ],
                                },
                            }),
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted: quoted, 
                upload: conn.waUploadToServer,
                ...ephemeral,
            },
        );
     conn.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
        });
        return msg
    }
  };


conn.sendButtonMessage = async (jid, array, quoted, json = {}, options = {}) => {
    const result = [];

    for (const data of array) {
    if (data.type === "reply") {
        for(const pair of data.value) {
            result.push({
                name: "quick_reply",
                buttonParamsJson: JSON.stringify({
                    display_text: pair[0],
                    id: pair[1],
                }),
            });
         }
        } else if (data.type === "url") {
         for (const pair of data.value) { 
        result.push({
          name: "cta_url",
          buttonParamsJson: JSON.stringify({
          display_text: pair[0],
          url: pair[1],
          merBott_url: pair[1],
             }),
          });
         }
        } else if (data.type === "copy") {
        for(const pair of data.value) {
            result.push({
                name: "cta_copy",
                buttonParamsJson: JSON.stringify({
                    display_text: pair[0],
                    copy_code: pair[1],
                }),
            });
         }
       } else if (data.type === "list") {
        let transformedData = data.value.map((item) => ({
        ...(item.headers ? {
            title: item.headers
        } : {}),
        rows: item.rows.map((row) => ({
            header: row.headers,
            title: row.title,
            description: row.body,
            id: row.command,
        })),
    }));

    let sections = transformedData;
    const listMessage = {
        title: data.title,
        sections,
    };
      result.push({
        name: "single_select",
        buttonParamsJson: JSON.stringify(listMessage),
        });
       }
    }

    let msg;
    if (json.url) {
        let file = await conn.getFile(json.url);
        let mime = file.mime.split("/")[0];
        let mediaMessage = await config.prepareWAMessageMedia({
            ...(mime === "image" ? { image: file.data } : 
               mime === "video" ? { video: file.data } : 
               { document: file.data, mimetype: file.mime, fileName: json.filename || "AkiraaBot." + extension(file.mime) }),
        }, { upload: conn.waUploadToServer });

        msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({ text: json.body }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({ text: json.footer }),
                            header: config.proto.Message.InteractiveMessage.Header.create({
                                hasMediaAttachment: true,
                                ...mediaMessage
                            }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result,
                            }),
                            ...options
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted,
                upload: conn.waUploadToServer,
                ...ephemeral,
            }
        );
    } else {
        msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({ text: json.body }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({ text: json.footer }),
                            header: config.proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result.length > 0 ? result : [{ text: "" }],
                            }),
                            ...options
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted,
                upload: conn.waUploadToServer,
                ...ephemeral,
            }
        );
    }

    await conn.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });
    return msg;
};

  conn.sendButton = async (jid, array, quoted, json = {}, options = {}) => {
    const result = [];
    for (const pair of array) {
      const obj = {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: pair[0],
          id: pair[1],
        }),
      };
      result.push(obj);
    }

    if (json.url) {
        let file = await conn.getFile(json.url);
        let mime = file.mime.split("/")[0];
        let msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                        },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({
                                text: json.body,
                            }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({
                                text: json.footer,
                            }),
                            header: config.proto.Message.InteractiveMessage.Header.create({
                                hasMediaAttachment: true,
                                   ...(await config.prepareWAMessageMedia({
                                ...(file.mime.split("/")[0] === "image" ?  {
                                     image: file.data,
                                                                
                                 } : file.mime.split("/")[0] === "video" ?  {
                                     video: file.data,
                                     
                                 } : {
                                     document: file.data,
                                     mimetype: file.mime,
                                     fileName: json.filename || "AkiraaBot." + extension(file.mime)             
                                 })
                               }, {
                                   upload: conn.waUploadToServer
                               })),
                            }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result,
                            }),
                            ...(options ? options : {
                                contextInfo: {
                                    mentionedJid: [
                                        ...conn.parseMention(json.body),
                                        ...conn.parseMention(json.footer),
                                    ],
                                },
                            }),
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted: quoted, 
                upload: conn.waUploadToServer,
                ...ephemeral,
            },
        );

        return conn.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
        });
    } else {
        let msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                        },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({
                                text: json.body,
                            }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({
                                text: json.footer,
                            }),
                            header: config.proto.Message.InteractiveMessage.Header.create({
                                hasMediaAttachment: false,
                            }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result || [{
                                    text: ""
                                }],
                            }),
                            ...(options ? options : {
                                contextInfo: {
                                    mentionedJid: [
                                        ...conn.parseMention(json.body),
                                        ...conn.parseMention(json.footer),
                                    ],
                                },
                            }),
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted: quoted, 

                upload: conn.waUploadToServer,
                ...ephemeral,
            },
        );
       conn.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
        });
        return msg
    }
  };
conn.sendList = async (jid, name, array, quoted, json = {}, options = {}) => {
    let transformedData = array.map((item) => ({
        ...(item.headers ? {
            title: item.headers
        } : {}),
        rows: item.rows.map((row) => ({
            header: row.headers,
            title: row.title,
            description: row.body,
            id: row.command,
        })),
    }));

    let sections = transformedData;
    const listMessage = {
        title: name,
        sections,
    };

    let result = [{
        name: "single_select",
        buttonParamsJson: JSON.stringify(listMessage),
    }];

    if (json.url) {
        let file = await conn.getFile(json.url);
        let mime = file.mime.split("/")[0];
        let msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                        },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({
                                text: json.body,
                            }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({
                                text: json.footer,
                            }),
                            header: config.proto.Message.InteractiveMessage.Header.create({
                                hasMediaAttachment: true,
                                ...(await config.prepareWAMessageMedia({
                                ...(file.mime.split("/")[0] === "image" ?  {
                                     image: file.data,                               
                                 } : file.mime.split("/")[0] === "video" ?  {
                                     video: file.data,                               
                                 } :  {
                                     document: file.data,
                                     mimetype: file.mime,
                                     fileName: json.filename || "AkiraaBot." + extension(file.mime)             
                                 })
                               }, {
                                   upload: conn.waUploadToServer
                               })),
                            }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result,
                            }),
                            ...(options ? options : {
                                contextInfo: {
                                    mentionedJid: [
                                        ...conn.parseMention(json.body),
                                        ...conn.parseMention(json.footer),
                                    ],
                                },
                            }),
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted: quoted, 
                upload: conn.waUploadToServer,
                ...ephemeral,
            },
        );
      conn.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
        });
        return msg
    } else {
        let msg = config.generateWAMessageFromContent(
            jid, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                        },
                        interactiveMessage: config.proto.Message.InteractiveMessage.create({
                            body: config.proto.Message.InteractiveMessage.Body.create({
                                text: json.body,
                            }),
                            footer: config.proto.Message.InteractiveMessage.Footer.create({
                                text: json.footer,
                            }),
                            header: config.proto.Message.InteractiveMessage.Header.create({
                                hasMediaAttachment: false,
                            }),
                            nativeFlowMessage: config.proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: result || [{
                                    text: ""
                                }],
                            }),
                            ...(options ? options : {
                                contextInfo: {
                                    mentionedJid: [
                                        ...conn.parseMention(json.body),
                                        ...conn.parseMention(json.footer),
                                    ],
                                },
                            }),
                        }),
                    },
                },
            }, {
                userJid: conn.user.jid,
                quoted: quoted, 
                upload: conn.waUploadToServer,
                ...ephemeral,
            },
        );
        conn.relayMessage(msg.key.remoteJid, msg.message, {
            messageId: msg.key.id,
        });
        return msg
    }
};
  conn.fakeReply = (
    jid,
    text = "",
    fakeJid = conn.user.jid,
    fakeText = "",
    fakeGroupJid,
    options,
  ) => {
    return conn.sendMessage(
      jid,
      { text: text },
      {
        ephemeralExpiration: 86400,
        quoted: {
          key: {
            fromMe: fakeJid == conn.user.jid,
            participant: fakeJid,
            ...(fakeGroupJid ? { remoteJid: fakeGroupJid } : {}),
          },
          message: { conversation: fakeText },
          ...options,
        },
      },
    );
  };

  conn.decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      let decode = config.jidDecode(jid) || {};
      return (
        (decode.user && decode.server && decode.user + "@" + decode.server) ||
        jid
      );
    } else return jid;
  };

  /**
   *
   * @param {*} jid
   * @param {*} text
   * @param {*} quoted
   * @param {*} options
   * @returns
   */
  conn.sendText = (jid, text, quoted = "", options) =>
    conn.sendMessage(jid, { text: text, ...options }, { quoted: quoted, ...ephemeral });

  /**
   * sendGroupV4Invite
   * @param {String} jid
   * @param {*} participant
   * @param {String} inviteCode
   * @param {Number} inviteExpiration
   * @param {String} groupName
   * @param {String} caption
   * @param {*} options
   * @returns
   */
  conn.sendGroupV4Invite = async (
    jid,
    participant,
    inviteCode,
    inviteExpiration,
    groupName = "unknown subject",
    caption = "Invitation to join my WhatsApp group",
    options = {},
  ) => {
    let msg = config.proto.Message.fromObject({
      groupInviteMessage: config.proto.GroupInviteMessage.fromObject({
        inviteCode,
        inviteExpiration:
          parseInt(inviteExpiration) || +new Date(new Date() + 3 * 86400000),
        groupJid: jid,
        groupName: groupName ? groupName : this.getName(jid),
        caption,
      }),
    });
    let message = await this.prepareMessageFromContent(
      participant,
      msg,
      options,
    );
    await this.relayWAMessage(message);
    return message;
  };

  /**
   * cMod
   * @param {String} jid
   * @param {config.proto.WebMessageInfo} message
   * @param {String} text
   * @param {String} sender
   * @param {*} options
   * @returns
   */


  /**
   * Exact Copy Forward
   * @param {String} jid
   * @param {config.proto.WebMessageInfo} message
   * @param {Boolean|Number} forwardingScore
   * @param {Object} options
   */
conn.copyNForward = async (
    jid,
    message,
    forwardingScore = true,
    quoted,
    options = {},
  ) => {
    let m = config.generateForwardMessageContent(message, !!forwardingScore);
    let mtype = Object.keys(m)[0];
    if (
      forwardingScore &&
      typeof forwardingScore == "number" &&
      forwardingScore > 1
    )
      m[mtype].contextInfo.forwardingScore += forwardingScore;
    m = config.generateWAMessageFromContent(jid, m, {
      ...options,
      userJid: conn.user.id
    });
    await conn.relayMessage(jid, m.message, {
      messageId: m.key.id,
      additionalAttributes: { ...options },
    });
    return m;
  };

  conn.loadMessage =
    conn.loadMessage ||
    (async (messageID) => {
      return Object.entries(conn.chats)
        .filter(([_, { messages }]) => typeof messages === "object")
        .find(([_, { messages }]) =>
          Object.entries(messages).find(
            ([k, v]) => k === messageID || v.key?.id === messageID,
          ),
        )?.[1].messages?.[messageID];
    });

  /**
   * Download media message
   * @param {Object} m
   * @param {String} type
   * @param {fs.PathLike|fs.promises.FileHandle} filename
   * @returns {Promise<fs.PathLike|fs.promises.FileHandle|Buffer>}
   */
  conn.downloadM = async (m, type, saveToFile) => {
    if (!m || !(m.url || m.directPath)) return Buffer.alloc(0);
    const stream = await config.downloadContentFromMessage(m, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    if (saveToFile) var { filename } = await conn.getFile(buffer, true);
    return saveToFile && fs.existsSync(filename) ? filename : buffer;
  };

  conn.downloadAndSaveMediaMessage = async (
    message,
    filename,
    attachExtension = true,
  ) => {
    let quoted = message.msg ? message.msg : message;
    let mime = (message.msg || message).mimetype || "";
    let messageType = message.mtype
      ? message.mtype.replace(/Message/gi, "")
      : mime.split("/")[0];
    const stream = await config.downloadContentFromMessage(quoted, messageType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    let type = await FileType.fromBuffer(buffer);
    trueFileName = attachExtension ? filename + "." + type.ext : filename;
    // save to file
    await fs.writeFileSync(trueFileName, buffer);
    return trueFileName;
  };

  /**
   * parseMention(s)
   * @param {string} text
   * @returns {string[]}
   */
  conn.parseMention = (text = "") => {
    return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(
      (v) => v[1] + "@s.whatsapp.net",
    );
  };
  /**
   * Read message
   * @param {String} jid
   * @param {String|undefined|null} participant
   * @param {String} messageID
   */
  conn.chatRead = async (jid, participant = conn.user.jid, messageID) => {
    return await conn.sendReadReceipt(jid, participant, [messageID]);
  };

  conn.sendStimg = async (jid, path, quoted, options = {}) => {
    let buff = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await (await fetch(path)).buffer()
          : fs.existsSync(path)
            ? fs.readFileSync(path)
            : Buffer.alloc(0);
    let buffer;
    if (options && (options.packname || options.author)) {
      buffer = await writeExifImg(buff, options);
    } else {
      buffer = await imageToWebp(buff);
    }
    await conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted: quoted, ...ephemeral },
    );
    return buffer;
  };

  conn.sendStvid = async (jid, path, quoted, options = {}) => {
    let buff = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await getBuffer(path)
          : fs.existsSync(path)
            ? fs.readFileSync(path)
            : Buffer.alloc(0);
    let buffer;
    if (options && (options.packname || options.author)) {
      buffer = await writeExifVid(buff, options);
    } else {
      buffer = await videoToWebp(buff);
    }
    await conn.sendMessage(
      jid,
      { sticker: { url: buffer }, ...options },
      { quoted: quoted, ...ephemeral },
    );
    return buffer;
  };

  /**
   * Parses string into mentionedJid(s)
   * @param {String} text
   */
  conn.parseMention = (text = "") => {
    return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(
      (v) => v[1] + "@s.whatsapp.net",
    );
  };

  conn.sendTextWithMentions = async (jid, text, quoted, options = {}) =>
    conn.sendMessage(
      jid,
      {
        text: text,
        contextInfo: {
          mentionedJid: [...text.matchAll(/@(\d{0,16})/g)].map(
            (v) => v[1] + "@s.whatsapp.net",
          ),
        },
        ...options,
      },
      { quoted: quoted, ...ephemeral },
    );

  /**
   * Get name from jid
   * @param {String} jid
   * @param {Boolean} withoutContact
   */
 conn.getName = (jid = "", withoutContact = false) => {
    jid = conn.decodeJid(jid);
    withoutContact = this.withoutContact || withoutContact;
    let v;
    if (jid.endsWith("@g.us"))
      return new Promise(async (resolve) => {
        v = conn.chats[jid] || {};
        if (!(v.name || v.subject)) v = (store.groupMetadata[jid]) || {};
        resolve(
          v.name ||
            v.subject ||
            PhoneNumber("+" + jid.replace("@s.whatsapp.net", "")).getNumber(
              "international",
            ),
        );
      });
    else
      v =
        jid === "0@s.whatsapp.net"
          ? {
              jid,
              vname: "WhatsApp",
            }
          : config.areJidsSameUser(jid, conn.user.id)
            ? conn.user
            : conn.chats[jid] || {};
    return (
      (withoutContact ? "" : v.name) ||
      v.subject ||
      v.vname ||
      v.notify ||
      v.verifiedName ||
      PhoneNumber("+" + jid.replace("@s.whatsapp.net", "")).getNumber(
        "international",
      )
    );
  };

  /**
   * to process MessageStubType
   * @param {config.proto.WebMessageInfo} m
   */
  conn.processMessageStubType = async (m) => {
    /**
     * to process MessageStubType
     * @param {import('@adiwajshing/baileys').config.proto.WebMessageInfo} m
     */
    if (!m.messageStubType) return;
    const chat = conn.decodeJid(
      m.key.remoteJid || m.message?.senderKeyDistributionMessage?.groupId || "",
    );
    if (!chat || chat === "status@broadcast") return;
    const emitGroupUpdate = (update) => {
      conn.ev.emit("groups.update", [{ id: chat, ...update }]);
    };
    switch (m.messageStubType) {
      case config.WAMessageStubType.REVOKE:
      case config.WAMessageStubType.GROUP_BotGE_INVITE_LINK:
        emitGroupUpdate({ revoke: m.messageStubParameters[0] });
        break;
      case config.WAMessageStubType.GROUP_BotGE_ICON:
        emitGroupUpdate({ icon: m.messageStubParameters[0] });
        break;
      default: {
        console.log({
          messageStubType: m.messageStubType,
          messageStubParameters: m.messageStubParameters,
          type: config.WAMessageStubType[m.messageStubType],
        });
        break;
      }
    }
    const isGroup = chat.endsWith("@g.us");
    if (!isGroup) return;
    let chats = conn.chats[chat];
    if (!chats) chats = conn.chats[chat] = { id: chat };
    chats.isChats = true;
    const metadata = await conn.groupMetadata(chat).catch((_) => null);
    if (!metadata) return;
    chats.subject = metadata.subject;
    chats.metadata = metadata;
  };
  conn.insertAllGroup = async () => {
    const groups =
      (await conn.groupFetchAllParticipating().catch((_) => null)) || {};
    for (const group in groups)
      conn.chats[group] = {
        ...(conn.chats[group] || {}),
        id: group,
        subject: groups[group].subject,
        isChats: true,
        metadata: groups[group],
      };
    return conn.chats;
  };

  /*conn.processMessageStubType = async (m) => {
        if (!m.messageStubType) return
        const mtype = Object.keys(m.message || {})[0]
        const chat = conn.decodeJid(m.key.remoteJid || m.message[mtype] && m.message[mtype].groupId || '')
        const isGroup = chat.endsWith('@g.us')
        if (!isGroup) return
        let chats = conn.chats[chat]
        if (!chats) chats = conn.chats[chat] = { id: chat }
        chats.isChats = true
        const metadata = await conn.groupMetadata(chat).catch(_ => null)
        if (!metadata) return
        chats.subject = metadata.subject
        chats.metadata = metadata
    }*/

  /**
   * pushMessage
   * @param {config.proto.WebMessageInfo[]} m
   */
  conn.pushMessage = async (m) => {
    /**
     * pushMessage
     * @param {import('@adiwajshing/baileys').config.proto.WebMessageInfo[]} m
     */
    if (!m) return;
    if (!Array.isArray(m)) m = [m];
    for (const message of m) {
      try {
        // if (!(message instanceof config.proto.WebMessageInfo)) continue // https://github.com/adiwajshing/Baileys/pull/696/commits/6a2cb5a4139d8eb0a75c4c4ea7ed52adc0aec20f
        if (!message) continue;
        if (
          message.messageStubType &&
          message.messageStubType != config.WAMessageStubType.CIPHERTEXT
        )
          conn.processMessageStubType(message).catch(console.error);
        const _mtype = Object.keys(message.message || {});
        const mtype =
          (!["senderKeyDistributionMessage", "messageContextInfo"].includes(
            _mtype[0],
          ) &&
            _mtype[0]) ||
          (_mtype.length >= 3 &&
            _mtype[1] !== "messageContextInfo" &&
            _mtype[1]) ||
          _mtype[_mtype.length - 1];
        const chat = conn.decodeJid(
          message.key.remoteJid ||
            message.message?.senderKeyDistributionMessage?.groupId ||
            "",
        );
        if (message.message?.[mtype]?.contextInfo?.quotedMessage) {
          /**
           * @type {import('@adiwajshing/baileys').config.proto.IContextInfo}
           */
          let context = message.message[mtype].contextInfo;
          let participant = conn.decodeJid(context.participant);
          const remoteJid = conn.decodeJid(context.remoteJid || participant);
          /**
           * @type {import('@adiwajshing/baileys').config.proto.IMessage}
           *
           */
          let quoted = message.message[mtype].contextInfo.quotedMessage;
          if (remoteJid && remoteJid !== "status@broadcast" && quoted) {
            let qMtype = Object.keys(quoted)[0];
            if (qMtype == "conversation") {
              quoted.extendedTextMessage = { text: quoted[qMtype] };
              delete quoted.conversation;
              qMtype = "extendedTextMessage";
            }

            if (!quoted[qMtype].contextInfo) quoted[qMtype].contextInfo = {};
            quoted[qMtype].contextInfo.mentionedJid =
              context.mentionedJid ||
              quoted[qMtype].contextInfo.mentionedJid ||
              [];
            const isGroup = remoteJid.endsWith("g.us");
            if (isGroup && !participant) participant = remoteJid;
            const qM = {
              key: {
                remoteJid,
                fromMe: config.areJidsSameUser(conn.user.jid, remoteJid),
                id: context.stanzaId,
                participant,
              },
              message: JSON.parse(JSON.stringify(quoted)),
              ...(isGroup ? { participant } : {}),
            };
            let qChats = conn.chats[participant];
            if (!qChats)
              qChats = conn.chats[participant] = {
                id: participant,
                isChats: !isGroup,
              };
            if (!qChats.messages) qChats.messages = {};
            if (!qChats.messages[context.stanzaId] && !qM.key.fromMe)
              qChats.messages[context.stanzaId] = qM;
            let qChatsMessages;
            if ((qChatsMessages = Object.entries(qChats.messages)).length > 40)
              qChats.messages = Object.fromEntries(
                qChatsMessages.slice(30, qChatsMessages.length),
              ); // maybe avoid memory leak
          }
        }
        if (!chat || chat === "status@broadcast") continue;
        const isGroup = chat.endsWith("@g.us");
        let chats = conn.chats[chat];
        if (!chats) {
          if (isGroup) await conn.insertAllGroup().catch(console.error);
          chats = conn.chats[chat] = {
            id: chat,
            isChats: true,
            ...(conn.chats[chat] || {}),
          };
        }
        let metadata, sender;
        if (isGroup) {
          if (!chats.subject || !chats.metadata) {
            metadata =
              (await conn.groupMetadata(chat).catch((_) => ({}))) || {};
            if (!chats.subject) chats.subject = metadata.subject || "";
            if (!chats.metadata) chats.metadata = metadata;
          }
          sender = conn.decodeJid(
            (message.key?.fromMe && conn.user.id) ||
              message.participant ||
              message.key?.participant ||
              chat ||
              "",
          );
          if (sender !== chat) {
            let chats = conn.chats[sender];
            if (!chats) chats = conn.chats[sender] = { id: sender };
            if (!chats.name) chats.name = message.pushName || chats.name || "";
          }
        } else if (!chats.name)
          chats.name = message.pushName || chats.name || "";
        if (
          ["senderKeyDistributionMessage", "messageContextInfo"].includes(mtype)
        )
          continue;
        chats.isChats = true;
        if (!chats.messages) chats.messages = {};
        const fromMe =
          message.key.fromMe || config.areJidsSameUser(sender || chat, conn.user.id);
        if (
          !["protocolMessage"].includes(mtype) &&
          !fromMe &&
          message.messageStubType != config.WAMessageStubType.CIPHERTEXT &&
          message.message
        ) {
          delete message.message.messageContextInfo;
          delete message.message.senderKeyDistributionMessage;
          chats.messages[message.key.id] = JSON.parse(
            JSON.stringify(message, null, 2),
          );
          let chatsMessages;
          if ((chatsMessages = Object.entries(chats.messages)).length > 40)
            chats.messages = Object.fromEntries(
              chatsMessages.slice(30, chatsMessages.length),
            );
        }
      } catch (e) {
        console.error(e);
      }
    }
  };

  /*
   * Send Polling
   */
  conn.getFile = async (path) => {
    let res;
    let data = Buffer.isBuffer(path)
      ? path
      : /^data:.*?\/.*?;base64,/i.test(path)
        ? Buffer.from(path.split`,`[1], "base64")
        : /^https?:\/\//.test(path)
          ? await (res = await fetch(path)).buffer()
          : fs.existsSync(path)
            ? fs.readFileSync(path)
            : typeof path === "string"
              ? path
              : Buffer.alloc(0);
    if (!Buffer.isBuffer(data)) throw new TypeError("Result is not a buffer");
    let type = (await FileType.fromBuffer(data)) || {
      mime: "application/octet-stream",
      ext: ".bin",
    };

    return {
      res,
      ...type,
      data,
    };
  };

  conn.sendPoll = async (jid, name = "", optiPoll, options) => {
    if (!Array.isArray(optiPoll[0]) && typeof optiPoll[0] === "string")
      optiPoll = [optiPoll];
    if (!options) options = {};
    const pollMessage = {
      name: name,
      options: optiPoll.map((btn) => ({ optionName: btn[0] || "" })),
      selectableOptionsCount: 1,
    };
    return conn.relayMessage(
      jid,
      { pollCreationMessage: pollMessage },
      { ...options },
    );
  };

  /*
   * Set auto Bio
   */

  conn.setBio = async (status) => {
    return await conn.query({
      tag: "iq",
      attrs: {
        to: "s.whatsapp.net",
        type: "set",
        xmlns: "status",
      },
      content: [
        {
          tag: "status",
          attrs: {},
          content: Buffer.from(status, "utf-8"),
        },
      ],
    });
    // <iq to="s.whatsapp.net" type="set" xmlns="status" id="21168.6213-69"><status>"Hai, saya menggunakan WhatsApp"</status></iq>
  };

  /**
   *
   * @param  {...any} args
   * @returns
   */
  conn.format = (...args) => {
    return util.format(...args);
  };

  /**
   *
   * @param {String} url
   * @param {Object} options
   * @returns
   */
  conn.getBuffer = async (url, options) => {
    try {
      options ? options : {};
      const res = await axios({
        method: "get",
        url,
        headers: {
          DNT: 1,
          "Upgrade-Insecure-Request": 1,
        },
        ...options,
        responseType: "arraybuffer",
      });
      return res.data;
    } catch (e) {
      console.log(`Error : ${e}`);
    }
  };

  /**
   * Serialize Message, so it easier to manipulate
   * @param {Object} m
   */
  conn.serializeM = (m) => {
    return require("./serialize").smsg(conn, m, config);
  };

  Object.defineProperty(conn, "name", {
    value: "WASocket",
    configurable: true,
  });
  return conn;
};

function isNumber() {
  const int = parseInt(this);
  return typeof int === "number" && !isNaN(int);
}

function getRandom() {
  if (Array.isArray(this) || this instanceof String)
    return this[Math.floor(Math.random() * this.length)];
  return Math.floor(Math.random() * this);
}

function rand(isi) {
  return isi[Math.floor(Math.random() * isi.length)];
}
