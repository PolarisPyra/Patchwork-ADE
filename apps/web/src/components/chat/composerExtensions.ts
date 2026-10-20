import { InputRule, mergeAttributes, Node } from "@tiptap/core";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import Mention, { type MentionOptions } from "@tiptap/extension-mention";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

const GOAL_CLASS =
  "rounded-[4px] bg-accent/30 px-1 py-0.5 font-[family-name:var(--font-mono)] text-fg";
const MENTION_CLASS = "rounded-[4px] bg-selected-muted px-1 text-accent-text";

/** A slash command, such as `/goal`. It is an atom, so the whole command selects and deletes together. */
export const GoalCommand = Node.create({
  name: "goalCommand",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  parseHTML() {
    return [{ tag: "span[data-goal-command]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-goal-command": "", class: GOAL_CLASS }),
      "/goal",
    ];
  },
  renderMarkdown: () => "/goal",
  // Typing "/goal " by hand gives the same chip as choosing it from the menu.
  addInputRules() {
    const type = this.type;
    return [
      new InputRule({
        find: /(?:^|\s)\/goal\s$/,
        handler: ({ state, range }) => {
          state.tr.replaceWith(range.to - 6, range.to, [type.create(), state.schema.text(" ")]);
        },
      }),
    ];
  },
});

/**
 * A reference to a project file, written `@path` in the draft. The agent reads the path as
 * typed, so it serialises to the same text the mention shows.
 */
const FileMention = Mention.extend({
  renderMarkdown: (node: { attrs?: { id?: string; label?: string } }) =>
    `@${node.attrs?.label ?? node.attrs?.id ?? ""}`,
});

/** The suggestions behind the `@` trigger: the project's files, filtered as the user types. */
export type MentionSuggestion = MentionOptions["suggestion"];

/**
 * Everything the composer edits: Markdown blocks (code, lists, task lists), links, the
 * inline command and file mentions, and the placeholder.
 */
export function composerExtensions(placeholder: string, mentionSuggestion: MentionSuggestion) {
  return [
    // Links keep their Markdown form; clicking one in a draft does not open it.
    // Dropped files become attachments (see Chat.tsx), so the drop cursor would point at a
    // place nothing is inserted.
    StarterKit.configure({ dropcursor: false, link: { openOnClick: false, autolink: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit,
    Placeholder.configure({ placeholder }),
    Markdown,
    GoalCommand,
    FileMention.configure({
      HTMLAttributes: { class: MENTION_CLASS },
      renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
      suggestion: mentionSuggestion,
    }),
  ];
}

/**
 * A draft is the Markdown the user writes, so its plain text is sent exactly as typed. The
 * serializer escapes `*`, `_`, `<` and similar for rich text, which would send backslashes
 * and entities the user never wrote. Marks such as bold and code still render as Markdown.
 * This overrides a method of @tiptap/markdown's manager; re-check it when that package updates.
 */
export function keepDraftText(manager: object) {
  // The declaration marks this method private; it is public at runtime.
  (manager as { encodeTextForMarkdown: (text: string) => string }).encodeTextForMarkdown = (text) =>
    text;
}
