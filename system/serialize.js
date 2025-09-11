const util = require("util");
const {
  extractMessageContent,
  jidNormalizedUser,
  areJidsSameUser,
} = require("@kelvdra/bails");

// ambil tipe konten pesan
const getContentType = (content) => {
  if (!content) return;
  const keys = Object.keys(content);
  return keys.find(
    (k) =>
      (k === "conversation" ||
        k.endsWith("Message") ||
        k.includes("V2") ||
        k.includes("V3")) &&
      k !== "senderKeyDistributionMessage"
  );
};

// escape regex
function escapeRegExp(string) {
  return string.replace(/[.*=+:\-?^${}()|[\]\\]|\s/g, "\\$&");
}

// parsing isi pesan
function parseMessage(content) {
  content = extractMessageContent(content);

  if (content?.viewOnceMessageV2Extension) {
    content = content.viewOnceMessageV2Extension.message;
  }
  if (content?.protocolMessage?.type == 14) {
    let type = getContentType(content.protocolMessage);
    content = content.protocolMessage[type];
  }
  if (content?.message) {
    let type = getContentType(content.message);
    content = content.message[type];
  }
  return content;
}

exports.smsg = async (messages, conn, store) => {
  const m = {};
  if (!messages.message) return;

  m.message = parseMessage(messages.message);

  if (messages.key) {
    m.key = messages.key;
    m.chat = m.key.remoteJid.startsWith("status")
      ? jidNormalizedUser(m.key?.participant || messages.participant)
      : jidNormalizedUser(m.key.remoteJid);

    m.fromMe = m.key.fromMe;
    m.id = m.key.id;

    m.device = /^3A/.test(m.id)
      ? "ios"
      : m.id.startsWith("3EB")
      ? "web"
      : /^.{21}/.test(m.id)
      ? "android"
      : /^.{18}/.test(m.id)
      ? "desktop"
      : "unknown";

    m.isBaileys =
      m.id.startsWith("BAE5") ||
      m.id.startsWith("HSK") ||
      m.id.includes("LTS");

    m.isGroup = m.chat.endsWith("@g.us");
    m.participant = jidNormalizedUser(
      messages?.participant || m.key.participant
    );
    m.sender = jidNormalizedUser(
      m.fromMe ? conn.user.id : m.isGroup ? m.participant : m.chat
    );
  }

  // ambil metadata group
  if (m.isGroup) {
    if (!(m.chat in store.groupMetadata))
      store.groupMetadata[m.chat] = await conn.groupMetadata(m.chat);

    m.metadata = store.groupMetadata[m.chat];
    m.groupAdmins = m.metadata.participants.filter((p) => p.admin);
    m.isAdmin = !!m.groupAdmins.find((p) => p.id === m.sender);
    m.isBotAdmin = !!m.groupAdmins.find(
      (p) => p.id === jidNormalizedUser(conn.user.id)
    );
  }

  m.name = messages.pushName;

  if (m.message) {
    m.mtype = getContentType(m.message) || Object.keys(m.message)[0];
    m.msg = parseMessage(m.message[m.mtype]) || m.message[m.mtype];
    m.mentions = [
      ...(m.msg?.contextInfo?.mentionedJid || []),
      ...(m.msg?.contextInfo?.groupMentions?.map((v) => v.groupJid) || []),
    ];
    m.text =
      m.msg?.text ||
      m.msg?.conversation ||
      m.msg?.caption ||
      m.message?.conversation ||
      m.msg?.selectedButtonId ||
      m.msg?.singleSelectReply?.selectedRowId ||
      m.msg?.selectedId ||
      m.msg?.contentText ||
      m.msg?.selectedDisplayText ||
      m.msg?.title ||
      m.msg?.name ||
      "";
    m.prefix = new RegExp(
      "^[°•π÷×¶∆£¢€¥®™+✓=|/~!?@#%^&.©^]",
      "gi"
    ).test(m.text)
      ? m.text.match(
          new RegExp("^[°•π÷×¶∆£¢€¥®™+✓=|/~!?@#%^&.©^]", "gi")
        )[0]
      : "";
    m.command = m.text
      .trim()
      .replace(m.prefix, "")
      .trim()
      .split(/ +/)
      .shift();
    m.args =
      m.text
        .trim()
        .replace(new RegExp("^" + escapeRegExp(m.prefix), "i"), "")
        .replace(m.command, "")
        .split(/ +/)
        .filter((a) => a) || [];
    m.input = m.args.join(" ").trim();
    m.expiration = m.msg?.contextInfo?.expiration || 0;
    m.timestamps =
      typeof messages.messageTimestamp === "number"
        ? messages.messageTimestamp * 1000
        : m.msg.timestampMs * 1000;
    m.isMedia = !!m.msg?.mimetype || !!m.msg?.thumbnailDirectPath;
  }

  // quoted message
  m.isQuoted = false;
  if (m.msg?.contextInfo?.quotedMessage) {
    m.isQuoted = true;
    m.quoted = {};
    m.quoted.message = parseMessage(m.msg?.contextInfo?.quotedMessage);

    if (m.quoted.message) {
      m.quoted.mtype =
        getContentType(m.quoted.message) || Object.keys(m.quoted.message)[0];
      m.quoted.msg =
        parseMessage(m.quoted.message[m.quoted.mtype]) ||
        m.quoted.message[m.quoted.mtype];
      m.quoted.key = {
        remoteJid: m.msg?.contextInfo?.remoteJid || m.chat,
        participant: jidNormalizedUser(m.msg?.contextInfo?.participant),
        fromMe: areJidsSameUser(
          jidNormalizedUser(m.msg?.contextInfo?.participant),
          jidNormalizedUser(conn?.user?.id)
        ),
        id: m.msg?.contextInfo?.stanzaId,
      };
      m.quoted.chat = /g\.us|status/.test(m.msg?.contextInfo?.remoteJid)
        ? m.quoted.key.participant
        : m.quoted.key.remoteJid;
      m.quoted.fromMe = m.quoted.key.fromMe;
      m.quoted.id = m.msg?.contextInfo?.stanzaId;
      m.quoted.device = /^3A/.test(m.quoted.id)
        ? "ios"
        : /^3E/.test(m.quoted.id)
        ? "web"
        : /^.{21}/.test(m.quoted.id)
        ? "android"
        : /^.{18}/.test(m.quoted.id)
        ? "desktop"
        : "unknown";
      m.quoted.isMedia =
        !!m.quoted.msg?.mimetype || !!m.quoted.msg?.thumbnailDirectPath;
      m.quoted.isBaileys =
        m.quoted.id.startsWith("BAE5") ||
        m.quoted.id.startsWith("HSK") ||
        m.id.includes("LTS");
      m.quoted.isGroup = m.quoted.chat.endsWith("@g.us");
      m.quoted.participant = jidNormalizedUser(m.msg?.contextInfo?.participant);
      m.quoted.sender = jidNormalizedUser(
        m.msg?.contextInfo?.participant || m.quoted.chat
      );
      m.quoted.mentions = [
        ...(m.quoted.msg?.contextInfo?.mentionedJid || []),
        ...(m.quoted.msg?.contextInfo?.groupMentions?.map((v) => v.groupJid) ||
          []),
      ];
      m.quoted.text =
        m.quoted.msg?.text ||
        m.quoted.msg?.caption ||
        m.quoted?.message?.conversation ||
        m.quoted.msg?.selectedButtonId ||
        m.quoted.msg?.singleSelectReply?.selectedRowId ||
        m.quoted.msg?.selectedId ||
        m.quoted.msg?.contentText ||
        m.quoted.msg?.selectedDisplayText ||
        m.quoted.msg?.title ||
        m.quoted?.msg?.name ||
        "";
    }
  }

  // helper
  m.reply = async (pesan, options) => {
    const a = { contextInfo: { mentionedJid: conn.parseMention(pesan) } };
    try {
      if (options && pesan) {
        await conn.sendFile(m.chat, options, null, pesan, m, null, a);
      } else if (pesan) {
        if (typeof pesan === "object") {
          await conn.sendMessage(
            m.chat,
            { ...pesan },
            { quoted: m, ephemeralExpiration: m.expiration }
          );
        } else {
          await conn.reply(m.chat, pesan, m, a);
        }
      } else {
        await conn.reply(m.chat, options, m, a);
      }
    } catch (e) {
      conn.reply(m.chat, util.format(pesan), m, a);
    }
  };

  return m;
};
