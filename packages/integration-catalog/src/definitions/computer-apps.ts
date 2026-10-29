import { IntegrationDefinitionSchema } from "@opensteer/integration-core";
import { iphoneAppIntegrations } from "./iphone-apps.js";

const conversationSchema = {
  additionalProperties: false,
  properties: {
    conversationId: { type: "string" },
    displayName: { type: ["string", "null"] },
    isGroup: { type: "boolean" },
    lastMessageAt: { type: ["string", "null"] },
    participants: { items: { type: "string" }, type: "array" },
    service: { type: "string" },
  },
  required: [
    "conversationId",
    "displayName",
    "participants",
    "isGroup",
    "service",
    "lastMessageAt",
  ],
  type: "object",
} as const;

const messageSchema = {
  additionalProperties: false,
  properties: {
    conversationId: { type: "string" },
    hasAttachments: { type: "boolean" },
    id: { type: "string" },
    isFromMe: { type: "boolean" },
    sender: {
      description: 'The literal "me" for outgoing messages, otherwise the sender handle.',
      type: "string",
    },
    sentAt: { type: "string" },
    service: { type: "string" },
    text: { type: ["string", "null"] },
    truncated: {
      description: "True when text was cut at 16 KiB; the rest of the body is not returned.",
      type: "boolean",
    },
    undecoded: {
      description: "The body could not be decoded; text is null and the message is still returned.",
      type: "boolean",
    },
  },
  required: [
    "id",
    "conversationId",
    "sender",
    "isFromMe",
    "text",
    "truncated",
    "undecoded",
    "sentAt",
    "service",
    "hasAttachments",
  ],
  type: "object",
} as const;

/**
 * One action, field for field with `ComputerUseActionSchema` in
 * `@opensteer/protocol`. The two are written to agree: the Host validates
 * every batch against the zod union before it reaches a Mac, so a shape the
 * model can only learn here and the shape that is enforced there have to be
 * the same shape. `tests/computer-use-action-schema.test.ts` holds them to it.
 */
const actionTargetSchema = {
  description: "An element index from the latest observation, or a point in screenshot pixels.",
  oneOf: [
    {
      additionalProperties: false,
      properties: { index: { minimum: 0, type: "integer" } },
      required: ["index"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: { x: { minimum: 0, type: "integer" }, y: { minimum: 0, type: "integer" } },
      required: ["x", "y"],
      type: "object",
    },
  ],
} as const;

// Mirrors protocol LoginText; this catalog has no protocol dependency. The action-schema
// contract test checks that references and literal bounds agree on both surfaces.
const loginTextSchema = {
  additionalProperties: false,
  properties: {
    loginRef: { type: "string", pattern: "^lgn_[0-9a-f]{32}$" },
    field: { enum: ["username", "password", "code"] },
  },
  required: ["loginRef", "field"],
  type: "object",
} as const;
const loginTextDescription =
  'Literal text, or {loginRef, field: "username"|"password"|"code"} using the loginRef from sign_in.';

const actionSchema = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        button: { default: "left", enum: ["left", "right", "middle"] },
        count: { default: 1, enum: [1, 2, 3] },
        target: actionTargetSchema,
        type: { const: "click" },
      },
      required: ["type", "target"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        target: {
          ...actionTargetSchema,
          description:
            "The field to focus before typing. Without it, text goes to whatever has focus.",
        },
        text: {
          description: loginTextDescription,
          oneOf: [{ maxLength: 20_000, minLength: 1, type: "string" }, loginTextSchema],
        },
        type: { const: "type" },
      },
      required: ["type", "text"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        keys: {
          description: 'A shortcut such as "cmd+s".',
          maxLength: 64,
          minLength: 1,
          type: "string",
        },
        type: { const: "key" },
      },
      required: ["type", "keys"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        index: { minimum: 0, type: "integer" },
        type: { const: "setValue" },
        value: { maxLength: 100_000, type: "string" },
      },
      required: ["type", "index", "value"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        amount: { maximum: 20, minimum: 1, type: "integer" },
        direction: { enum: ["up", "down", "left", "right"] },
        target: actionTargetSchema,
        type: { const: "scroll" },
      },
      required: ["type", "target", "direction", "amount"],
      type: "object",
    },
  ],
} as const;

/**
 * One phone action, field for field with `AndroidPhoneActionSchema` in
 * `@opensteer/protocol`, held to it by `tests/computer-use-action-schema.test.ts`
 * for the same reason as the Mac's.
 */
const phoneActionSchema = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        count: { default: 1, enum: [1, 2] },
        target: actionTargetSchema,
        type: { const: "tap" },
      },
      required: ["type", "target"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        durationMs: { default: 800, maximum: 5_000, minimum: 400, type: "integer" },
        target: actionTargetSchema,
        type: { const: "longPress" },
      },
      required: ["type", "target"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        durationMs: { default: 300, maximum: 5_000, minimum: 50, type: "integer" },
        from: actionTargetSchema,
        to: actionTargetSchema,
        type: { const: "swipe" },
      },
      required: ["type", "from", "to"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        durationMs: { default: 600, maximum: 5_000, minimum: 100, type: "integer" },
        from: actionTargetSchema,
        holdMs: { default: 600, maximum: 3_000, minimum: 400, type: "integer" },
        to: actionTargetSchema,
        type: { const: "drag" },
      },
      required: ["type", "from", "to"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        submit: {
          default: false,
          description: "Press the keyboard's action key (Send, Search, Done) after typing.",
          type: "boolean",
        },
        target: {
          ...actionTargetSchema,
          description:
            "The field to type into. Without it, text goes to the field that has input focus.",
        },
        text: {
          description: loginTextDescription,
          oneOf: [{ maxLength: 5_000, minLength: 1, type: "string" }, loginTextSchema],
        },
        type: { const: "type" },
      },
      required: ["type", "text"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: { target: actionTargetSchema, type: { const: "clear" } },
      required: ["type", "target"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        to: { enum: ["back", "home", "recents", "notifications", "quickSettings"] },
        type: { const: "navigate" },
      },
      required: ["type", "to"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        packageName: {
          description: 'The app\'s Android package name, such as "com.android.settings".',
          maxLength: 255,
          minLength: 3,
          pattern: "^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$",
          type: "string",
        },
        type: { const: "launch" },
      },
      required: ["type", "packageName"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        amount: { maximum: 20, minimum: 1, type: "integer" },
        direction: {
          description: "The way the content moves into view: down shows what is further down.",
          enum: ["up", "down", "left", "right"],
        },
        target: actionTargetSchema,
        type: { const: "scroll" },
      },
      required: ["type", "target", "direction", "amount"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: { type: { const: "wake" } },
      required: ["type"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        ms: { maximum: 5_000, minimum: 1, type: "integer" },
        type: { const: "wait" },
      },
      required: ["type", "ms"],
      type: "object",
    },
  ],
} as const;

const labeledValueSchema = {
  additionalProperties: false,
  properties: {
    label: {
      description:
        'What the person called this entry, such as "mobile" or "work"; null when unlabeled.',
      type: ["string", "null"],
    },
    value: { type: "string" },
  },
  required: ["label", "value"],
  type: "object",
} as const;

const contactSchema = {
  additionalProperties: false,
  properties: {
    birthday: {
      description: "YYYY-MM-DD, or --MM-DD when the year is not recorded; null when none.",
      type: ["string", "null"],
    },
    emails: { items: labeledValueSchema, type: "array" },
    id: {
      description: "This contact on this Mac. Another Mac names the same person differently.",
      type: "string",
    },
    name: {
      description: "The name as Contacts displays it; null for a contact with no name.",
      type: ["string", "null"],
    },
    organization: { type: ["string", "null"] },
    phones: { items: labeledValueSchema, type: "array" },
  },
  required: ["id", "name", "organization", "emails", "phones", "birthday"],
  type: "object",
} as const;

/**
 * A day or a time on the Mac's clock, as Calendar and Reminders take them.
 * The helper parses it again; this only turns away what cannot be one.
 */
const momentPattern =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$";

function momentInput(description: string) {
  return {
    description: `${description} A date (YYYY-MM-DD) or a time (YYYY-MM-DDTHH:MM). A time without an offset is this Mac's local time; add one, such as -07:00 or Z, for an exact instant.`,
    pattern: momentPattern,
    type: "string",
  } as const;
}

/** Longest notes Calendar and Reminders read or write here. */
const notesMaxLength = 100_000;

const notesTruncatedSchema = {
  description: `notes was cut at ${notesMaxLength.toLocaleString("en-US")} characters; notes that long cannot be changed here.`,
  type: "boolean",
} as const;

function containerSchema(noun: string, verbs: string) {
  return {
    additionalProperties: false,
    properties: {
      account: {
        description: `The account holding the ${noun}, such as iCloud or an email address.`,
        type: ["string", "null"],
      },
      id: { type: "string" },
      isDefault: {
        description: `Where a new item goes when no ${noun} is named.`,
        type: "boolean",
      },
      title: { type: "string" },
      writable: { description: `Whether ${verbs} in it.`, type: "boolean" },
    },
    required: ["id", "title", "account", "writable", "isDefault"],
    type: "object",
  } as const;
}

const spanInput = {
  description:
    "For a repeating event: this (the default) reaches only this occurrence; future reaches it and every later one.",
  enum: ["this", "future"],
  type: "string",
} as const;

const eventSchema = {
  additionalProperties: false,
  properties: {
    allDay: { type: "boolean" },
    attendees: {
      items: {
        additionalProperties: false,
        properties: {
          email: { type: ["string", "null"] },
          isMe: { type: "boolean" },
          name: { type: ["string", "null"] },
          status: {
            enum: [
              "accepted",
              "declined",
              "tentative",
              "pending",
              "delegated",
              "completed",
              "in-process",
              "unknown",
            ],
            type: "string",
          },
        },
        required: ["name", "email", "status", "isMe"],
        type: "object",
      },
      type: "array",
    },
    calendarId: { type: "string" },
    end: {
      description:
        "An all-day event's last day (YYYY-MM-DD); otherwise when it ends, with this Mac's UTC offset.",
      type: "string",
    },
    id: {
      description:
        "This occurrence on this Mac. A change can give it a new id; use the one the change returns.",
      type: "string",
    },
    location: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
    notesTruncated: notesTruncatedSchema,
    recurring: { description: "Part of a repeating series.", type: "boolean" },
    start: {
      description:
        "An all-day event's first day (YYYY-MM-DD); otherwise when it starts, with this Mac's UTC offset.",
      type: "string",
    },
    status: { enum: ["confirmed", "tentative", "canceled", "none"], type: "string" },
    timeZone: {
      description: "The event's own time zone; null for an all-day or floating event.",
      type: ["string", "null"],
    },
    title: { type: "string" },
    url: { type: ["string", "null"] },
  },
  required: [
    "id",
    "calendarId",
    "title",
    "start",
    "end",
    "allDay",
    "timeZone",
    "location",
    "notes",
    "notesTruncated",
    "url",
    "recurring",
    "status",
    "attendees",
  ],
  type: "object",
} as const;

const eventResultSchema = {
  additionalProperties: false,
  properties: { event: eventSchema },
  required: ["event"],
  type: "object",
} as const;

const reminderSchema = {
  additionalProperties: false,
  properties: {
    completed: { type: "boolean" },
    completedAt: {
      description: "When it was completed, with this Mac's UTC offset.",
      type: ["string", "null"],
    },
    due: {
      description: "A due day (YYYY-MM-DD) or a due time with this Mac's UTC offset.",
      type: ["string", "null"],
    },
    id: { type: "string" },
    listId: { type: "string" },
    notes: { type: ["string", "null"] },
    notesTruncated: notesTruncatedSchema,
    priority: { enum: ["none", "low", "medium", "high"], type: "string" },
    recurring: { description: "Repeats once completed.", type: "boolean" },
    title: { type: "string" },
    url: { type: ["string", "null"] },
  },
  required: [
    "id",
    "listId",
    "title",
    "due",
    "priority",
    "completed",
    "completedAt",
    "notes",
    "notesTruncated",
    "url",
    "recurring",
  ],
  type: "object",
} as const;

const reminderResultSchema = {
  additionalProperties: false,
  properties: { reminder: reminderSchema },
  required: ["reminder"],
  type: "object",
} as const;

const deletedSchema = {
  additionalProperties: false,
  properties: { deleted: { enum: [true], type: "boolean" } },
  required: ["deleted"],
  type: "object",
} as const;

const cursorInput = { description: "Opaque cursor returned by an earlier call.", type: "string" };
const queryInput = (what: string) =>
  ({ description: what, maxLength: 200, minLength: 1, type: "string" }) as const;
const titleInput = { maxLength: 1_000, minLength: 1, type: "string" } as const;
const locationInput = { maxLength: 1_000, type: ["string", "null"] } as const;
const notesInput = { maxLength: notesMaxLength, type: ["string", "null"] } as const;
const urlInput = { maxLength: 2_000, type: ["string", "null"] } as const;
const priorityInput = { enum: ["none", "low", "medium", "high"], type: "string" } as const;
const pagingOutput = (key: string, items: object) =>
  ({
    additionalProperties: false,
    properties: { [key]: { items, type: "array" }, nextCursor: { type: ["string", "null"] } },
    required: [key, "nextCursor"],
    type: "object",
  }) as const;
const keepPaging =
  "Keep calling with the returned nextCursor until it is null; a cursor is valid only for the same operation and arguments.";

export const computerAppIntegrations = [
  IntegrationDefinitionSchema.parse({
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    config: {
      accessLabels: { read: "Read only", readWrite: "Read and send" },
      accessSummaries: {
        read: "Allows searching and reading conversations. Sending is off.",
        // Readiness is established for reading; macOS decides a send when it
        // happens, so the summary says so rather than implying it is settled.
        readWrite:
          "Allows searching and reading conversations, and sending messages as you. Sending may ask for macOS Automation permission on this Mac.",
      },
      operations: [
        {
          description:
            "List Messages conversations, most recently active first. query matches the conversation's name and its participants' handles (phone numbers, emails), never message text. To search message text use read_messages. Keep calling with the returned nextCursor until it is null; a cursor is valid only for the same operation and arguments.",
          effect: "read",
          inputSchema: {
            additionalProperties: false,
            properties: {
              cursor: { description: "Opaque cursor returned by an earlier call.", type: "string" },
              limit: {
                description: "Maximum conversations to return; defaults to 25.",
                maximum: 100,
                minimum: 1,
                type: "integer",
              },
              query: {
                description: "Text to find in the conversation name or a participant handle.",
                type: "string",
              },
            },
            type: "object",
          },
          name: "list_conversations",
          outputSchema: {
            additionalProperties: false,
            properties: {
              conversations: { items: conversationSchema, type: "array" },
              nextCursor: { type: ["string", "null"] },
            },
            required: ["conversations", "nextCursor"],
            type: "object",
          },
          title: "List conversations",
        },
        {
          description:
            "Read Messages, newest first. query matches decoded message text. Keep calling with the returned nextCursor until it is null; a cursor is valid only for the same operation and arguments. With query, a page may hold few or no messages and still return a nextCursor, because each call searches a bounded slice of the history: that means keep going, not no matches.",
          effect: "read",
          inputSchema: {
            additionalProperties: false,
            properties: {
              conversationId: {
                description: "Conversation to read, from list_conversations or read_messages.",
                type: "string",
              },
              cursor: { description: "Opaque cursor returned by an earlier call.", type: "string" },
              limit: {
                description: "Maximum messages to return; defaults to 50.",
                maximum: 200,
                minimum: 1,
                type: "integer",
              },
              query: {
                description: "Text to find in decoded message text.",
                type: "string",
              },
              since: {
                description: "Return messages sent at or after this ISO timestamp.",
                type: "string",
              },
              until: {
                description: "Return messages sent at or before this ISO timestamp.",
                type: "string",
              },
            },
            type: "object",
          },
          name: "read_messages",
          outputSchema: {
            additionalProperties: false,
            properties: {
              messages: { items: messageSchema, type: "array" },
              nextCursor: { type: ["string", "null"] },
            },
            required: ["messages", "nextCursor"],
            type: "object",
          },
          title: "Read messages",
        },
        {
          description:
            "Ask Messages to send text to one named conversation or iMessage address. A group is reachable only by conversationId. {accepted: true} means Messages accepted the send, not that it was delivered.",
          effect: "write",
          inputSchema: {
            additionalProperties: false,
            properties: {
              text: {
                description: "The message body; must not be empty.",
                maxLength: 4_000,
                minLength: 1,
                type: "string",
              },
              to: {
                oneOf: [
                  {
                    additionalProperties: false,
                    properties: {
                      conversationId: {
                        description:
                          "Conversation to send to, from list_conversations or read_messages.",
                        type: "string",
                      },
                    },
                    required: ["conversationId"],
                    type: "object",
                  },
                  {
                    additionalProperties: false,
                    properties: {
                      address: {
                        description: "Phone number or email address reached over iMessage.",
                        type: "string",
                      },
                    },
                    required: ["address"],
                    type: "object",
                  },
                ],
              },
            },
            required: ["to", "text"],
            type: "object",
          },
          name: "send_message",
          outputSchema: {
            additionalProperties: false,
            properties: { accepted: { enum: [true], type: "boolean" } },
            required: ["accepted"],
            type: "object",
          },
          title: "Send message",
        },
      ],
      platforms: ["darwin"],
    },
    description: "Search, read, and send Apple Messages through an enrolled Mac.",
    id: "apple-messages",
    name: "Apple Messages",
    provider: "apple-messages",
  }),
  IntegrationDefinitionSchema.parse({
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    config: {
      // Contacts offers reading only, so no connection can be read and write.
      accessLabels: { read: "Can read", readWrite: "Can read" },
      accessSummaries: {
        read: "Allows finding and reading contacts: names, organizations, email addresses, phone numbers and birthdays. Contacts cannot be changed.",
        readWrite:
          "Allows finding and reading contacts: names, organizations, email addresses, phone numbers and birthdays. Contacts cannot be changed.",
      },
      operations: [
        {
          description:
            "Find people in Contacts. query matches a name, an organization, an email address or a phone number, whose digits are compared however either side is formatted; without query, every shared contact is listed in this device's sort order. Keep calling with the returned nextCursor until it is null; a cursor is valid only for the same operation and arguments.",
          effect: "read",
          inputSchema: {
            additionalProperties: false,
            properties: {
              cursor: { description: "Opaque cursor returned by an earlier call.", type: "string" },
              limit: {
                description: "Maximum contacts to return; defaults to 25.",
                maximum: 100,
                minimum: 1,
                type: "integer",
              },
              query: {
                description: "A name, organization, email address or phone number.",
                maxLength: 200,
                minLength: 1,
                type: "string",
              },
            },
            type: "object",
          },
          name: "search_contacts",
          outputSchema: {
            additionalProperties: false,
            properties: {
              contacts: { items: contactSchema, type: "array" },
              nextCursor: { type: ["string", "null"] },
            },
            required: ["contacts", "nextCursor"],
            type: "object",
          },
          title: "Search contacts",
        },
      ],
      platforms: ["darwin", "ios"],
    },
    description:
      "Find and read Contacts through an enrolled Mac or iPhone. On an iPhone, Opensteer must be open.",
    id: "apple-contacts",
    name: "Contacts",
    provider: "apple-contacts",
  }),
  IntegrationDefinitionSchema.parse({
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    config: {
      accessLabels: { read: "Can read", readWrite: "Can read and change" },
      accessSummaries: {
        read: "Allows reading calendars and their events: titles, times, locations, notes and attendees. Events cannot be changed.",
        readWrite:
          "Allows reading calendars and their events, and creating, changing and deleting events in calendars that allow it.",
      },
      operations: [
        {
          description:
            "List the calendars on this device, with which of them take new events and which one is the default.",
          effect: "read",
          inputSchema: { additionalProperties: false, properties: {}, type: "object" },
          name: "list_calendars",
          outputSchema: {
            additionalProperties: false,
            properties: {
              calendars: {
                items: containerSchema("calendar", "events can be created, changed and deleted"),
                type: "array",
              },
            },
            required: ["calendars"],
            type: "object",
          },
          title: "List calendars",
        },
        {
          description: `List the events between start and end, earliest first, one entry per occurrence of a repeating event. An end date includes that whole day; the range is at most 366 days. query matches the title, location and notes. ${keepPaging}`,
          effect: "read",
          inputSchema: {
            additionalProperties: false,
            properties: {
              calendarIds: {
                description: "Only these calendars, from list_calendars.",
                items: { type: "string" },
                maxItems: 100,
                minItems: 1,
                type: "array",
              },
              cursor: cursorInput,
              end: momentInput("The end of the range."),
              limit: {
                description: "Maximum events to return; defaults to 50.",
                maximum: 200,
                minimum: 1,
                type: "integer",
              },
              query: queryInput("Text to find in the title, location or notes."),
              start: momentInput("The start of the range."),
            },
            required: ["start", "end"],
            type: "object",
          },
          name: "list_events",
          outputSchema: pagingOutput("events", eventSchema),
          title: "List events",
        },
        {
          description:
            "Create an event. For an all-day event set allDay and give start and end as dates, end being its last day; otherwise give times, end after start. Without calendarId it goes to the default calendar. Attendees cannot be invited here.",
          effect: "write",
          inputSchema: {
            additionalProperties: false,
            properties: {
              allDay: { type: "boolean" },
              calendarId: { description: "A calendar from list_calendars.", type: "string" },
              end: momentInput("When it ends."),
              location: locationInput,
              notes: notesInput,
              start: momentInput("When it starts."),
              title: titleInput,
              url: urlInput,
            },
            required: ["title", "start", "end"],
            type: "object",
          },
          name: "create_event",
          outputSchema: eventResultSchema,
          title: "Create event",
        },
        {
          description:
            "Change an event. Give only what changes; null clears location, notes or url. A new start alone keeps the event's length. Switching allDay needs both start and end. Returns the event, whose id may have changed.",
          effect: "write",
          inputSchema: {
            additionalProperties: false,
            properties: {
              allDay: { type: "boolean" },
              end: momentInput("When it ends."),
              id: { description: "The event, from list_events.", type: "string" },
              location: locationInput,
              notes: notesInput,
              span: spanInput,
              start: momentInput("When it starts."),
              title: titleInput,
              url: urlInput,
            },
            required: ["id"],
            type: "object",
          },
          name: "update_event",
          outputSchema: eventResultSchema,
          title: "Update event",
        },
        {
          description: "Delete an event.",
          effect: "write",
          inputSchema: {
            additionalProperties: false,
            properties: {
              id: { description: "The event, from list_events.", type: "string" },
              span: spanInput,
            },
            required: ["id"],
            type: "object",
          },
          name: "delete_event",
          outputSchema: deletedSchema,
          title: "Delete event",
        },
      ],
      platforms: ["darwin", "ios"],
    },
    description:
      "Read and change Calendar through an enrolled Mac or iPhone. On an iPhone, Opensteer must be open.",
    id: "apple-calendar",
    name: "Calendar",
    provider: "apple-calendar",
  }),
  IntegrationDefinitionSchema.parse({
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    config: {
      accessLabels: { read: "Can read", readWrite: "Can read and change" },
      accessSummaries: {
        read: "Allows reading reminder lists and their reminders. Reminders cannot be changed.",
        readWrite:
          "Allows reading reminder lists and their reminders, and creating, changing, completing and deleting reminders in lists that allow it.",
      },
      operations: [
        {
          description:
            "List the reminder lists on this device, with which of them take new reminders and which one is the default.",
          effect: "read",
          inputSchema: { additionalProperties: false, properties: {}, type: "object" },
          name: "list_reminder_lists",
          outputSchema: {
            additionalProperties: false,
            properties: {
              lists: {
                items: containerSchema("list", "reminders can be created, changed and deleted"),
                type: "array",
              },
            },
            required: ["lists"],
            type: "object",
          },
          title: "List reminder lists",
        },
        {
          description: `List reminders. Incomplete ones come soonest due first, then those with no due date; completed ones come most recently completed first. query matches the title and notes. ${keepPaging}`,
          effect: "read",
          inputSchema: {
            additionalProperties: false,
            properties: {
              cursor: cursorInput,
              limit: {
                description: "Maximum reminders to return; defaults to 50.",
                maximum: 200,
                minimum: 1,
                type: "integer",
              },
              listIds: {
                description: "Only these lists, from list_reminder_lists.",
                items: { type: "string" },
                maxItems: 100,
                minItems: 1,
                type: "array",
              },
              query: queryInput("Text to find in the title or notes."),
              status: {
                description: "Which reminders; defaults to incomplete.",
                enum: ["incomplete", "completed"],
                type: "string",
              },
            },
            type: "object",
          },
          name: "list_reminders",
          outputSchema: pagingOutput("reminders", reminderSchema),
          title: "List reminders",
        },
        {
          description:
            "Create a reminder. A due time also alerts at that time; a due date alone does not. Without listId it goes to the default list.",
          effect: "write",
          inputSchema: {
            additionalProperties: false,
            properties: {
              due: momentInput("When it is due."),
              listId: { description: "A list from list_reminder_lists.", type: "string" },
              notes: notesInput,
              priority: priorityInput,
              title: titleInput,
              url: urlInput,
            },
            required: ["title"],
            type: "object",
          },
          name: "create_reminder",
          outputSchema: reminderResultSchema,
          title: "Create reminder",
        },
        {
          description:
            "Change or complete a reminder. Give only what changes; null clears due, notes or url. Setting due replaces the reminder's alerts: a due time alerts then, and a date alone or null leaves none.",
          effect: "write",
          inputSchema: {
            additionalProperties: false,
            properties: {
              completed: { type: "boolean" },
              due: { ...momentInput("When it is due."), type: ["string", "null"] },
              id: { description: "The reminder, from list_reminders.", type: "string" },
              notes: notesInput,
              priority: priorityInput,
              title: titleInput,
              url: urlInput,
            },
            required: ["id"],
            type: "object",
          },
          name: "update_reminder",
          outputSchema: reminderResultSchema,
          title: "Update reminder",
        },
        {
          description: "Delete a reminder.",
          effect: "write",
          inputSchema: {
            additionalProperties: false,
            properties: {
              id: { description: "The reminder, from list_reminders.", type: "string" },
            },
            required: ["id"],
            type: "object",
          },
          name: "delete_reminder",
          outputSchema: deletedSchema,
          title: "Delete reminder",
        },
      ],
      platforms: ["darwin", "ios"],
    },
    description:
      "Read and change Reminders through an enrolled Mac or iPhone. On an iPhone, Opensteer must be open.",
    id: "apple-reminders",
    name: "Reminders",
    provider: "apple-reminders",
  }),
  IntegrationDefinitionSchema.parse({
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    config: {
      accessLabels: { read: "Can see", readWrite: "Can see and control" },
      accessSummaries: {
        read: "Allows observing the app: its accessibility tree and a screenshot, opening it in the background if needed.",
        readWrite:
          "Allows observing the app, and clicking, typing, scrolling, pressing keys and setting values in it, all in the background.",
      },
      kind: "gui",
      // Approval rows remain the authority units for the computer tool.
      operations: [
        {
          description:
            "Internal read operation used by the computer tool to list, bind and observe app windows.",
          effect: "read",
          inputSchema: {
            additionalProperties: false,
            properties: {
              operation: { enum: ["windows", "bind", "observe"], type: "string" },
              window: {
                type: ["integer", "string", "null"],
                minimum: 0,
                minLength: 1,
                maxLength: 128,
              },
              includeScreenshot: { type: "boolean" },
            },
            required: ["operation"],
            type: "object",
          },
          name: "observe",
          outputSchema: null,
          title: "Observe",
        },
        {
          description:
            "Internal write operation used by the computer tool to act on a bound app window. Returns completed action receipts without observing.",
          effect: "write",
          inputSchema: {
            additionalProperties: false,
            properties: {
              actions: { items: actionSchema, maxItems: 32, minItems: 1, type: "array" },
              window: { minLength: 1, maxLength: 128, type: "string" },
              snapshot: { minLength: 1, maxLength: 64, type: ["string", "null"] },
            },
            required: ["window", "snapshot", "actions"],
            type: "object",
          },
          name: "act",
          outputSchema: null,
          title: "Act",
        },
      ],
      platforms: ["darwin"],
    },
    description: "See and operate apps on a Mac in the background while the person keeps using it.",
    id: "macos-app",
    name: "Computer use",
    provider: "macos-app",
  }),
  IntegrationDefinitionSchema.parse({
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This phone" }],
    config: {
      accessLabels: { read: "Can see", readWrite: "Can see and control" },
      accessSummaries: {
        read: "Allows seeing the phone's screen: its accessibility tree and a screenshot. Never turns the screen on.",
        readWrite:
          "Allows seeing the phone's screen and operating it like a person: tapping, swiping, typing, pressing back and home, opening apps and turning the screen on.",
      },
      kind: "display",
      // A session holds the whole phone, so letting go of it is the agent's
      // own move rather than only the Host's bookkeeping: another task waits
      // for it otherwise. Releasing changes nothing on the phone, so it is a
      // read and a task that may only look can still let go.
      operations: [
        {
          description:
            'See the phone: whether its screen is on and locked, the app in front, its accessibility tree (one element per line: [index] role "text" (x,y w×h) flags) and a screenshot. All coordinates are screenshot pixels with the origin at the screenshot\'s top-left. A dark screen comes back with an empty tree: turn it on with the act wake action. A long tree is cut, and its last line then says how many elements were left out. act returns a fresh observation, so call observe only when you need a new look without acting.',
          effect: "read",
          inputSchema: { additionalProperties: false, properties: {}, type: "object" },
          name: "observe",
          outputSchema: null,
          title: "Observe",
        },
        {
          description:
            'Perform actions on the phone in order, then return a fresh observation. observationId is the latest observation id (from observe or the previous act); targets refer to it. Prefer {index} targets; use {x, y} only for something missing from the tree. tap, longPress, swipe and drag act like a finger; type inserts text at the cursor of its target field, or of the focused field, and submit then presses the keyboard\'s action key; clear empties a field; navigate presses back, home or recents or opens notifications or quick settings; launch opens an app by its package name, found with integration_search using the phone\'s runnerId; scroll moves the content under its target; wake turns the screen on. Holds, gestures and waits may add up to at most 40 seconds per batch. Stops at the first failure and reports how many actions completed. Example: {"observationId":"<id>","actions":[{"type":"wake"},{"type":"navigate","to":"home"}]}',
          effect: "write",
          inputSchema: {
            additionalProperties: false,
            properties: {
              actions: { items: phoneActionSchema, maxItems: 32, minItems: 1, type: "array" },
              observationId: {
                description: "The latest observation id of this phone.",
                maxLength: 64,
                minLength: 1,
                type: "string",
              },
            },
            required: ["observationId", "actions"],
            type: "object",
          },
          name: "act",
          outputSchema: null,
          title: "Act",
        },
        {
          description:
            "Let go of the phone so another task can use it. One task holds a phone at a time; release it as soon as you are done. It is also let go when this task ends or after a few idle minutes.",
          effect: "read",
          inputSchema: { additionalProperties: false, properties: {}, type: "object" },
          name: "release",
          outputSchema: null,
          title: "Release",
        },
      ],
      platforms: ["android"],
    },
    description: "See and operate the whole screen of an Android phone dedicated to agents.",
    id: "android-phone",
    name: "Android phone",
    provider: "android-phone",
  }),
  ...iphoneAppIntegrations,
] as const;
