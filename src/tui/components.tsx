import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

export interface DisplayItem {
  id: number;
  kind: "user" | "assistant" | "tool" | "note" | "shell-out" | "cmd";
  text: string;
  dim?: boolean;
}

let nextId = 1;
export function makeItem(kind: DisplayItem["kind"], text: string, dim = false): DisplayItem {
  return { id: nextId++, kind, text, dim };
}

/** Monochrome wordmark. */
export function Wordmark({ compact }: { compact?: boolean }): React.ReactElement {
  if (compact) {
    return (
      <Text bold>
        NOIR{" "}
        <Text dimColor>▪ agent harness</Text>
      </Text>
    );
  }
  return (
    <Box flexDirection="column" alignItems="flex-start">
      <Text bold>███╗   ██╗ ██████╗ ██╗██████╗ </Text>
      <Text bold>████╗  ██║██╔═══██╗██║██╔══██╗</Text>
      <Text bold>██╔██╗ ██║██║   ██║██║██║  ██║</Text>
      <Text bold>██║╚██╗██║██║   ██║██║██║  ██║</Text>
      <Text bold>██║ ╚████║╚██████╔╝██║██████╔╝</Text>
      <Text bold>╚═╝  ╚═══╝ ╚═════╝ ╚═╝╚═════╝</Text>
    </Box>
  );
}

export function Spinner({ label }: { label?: string }): React.ReactElement {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % frames.length), 90);
    return () => clearInterval(t);
  }, []);
  return (
    <Text bold>
      {frames[i]} {label ?? ""}
    </Text>
  );
}

export interface HeaderProps {
  provider: string;
  model: string;
  tokens: number;
  busy: boolean;
  compactAt: number;
  sessionTitle: string;
}

export function Header({ provider, model, tokens, busy, compactAt, sessionTitle }: HeaderProps): React.ReactElement {
  const pct = Math.min(100, Math.round((tokens / compactAt) * 100));
  const filled = Math.round(pct / 10);
  const bar = "▮".repeat(filled) + "▯".repeat(10 - filled);
  return (
    <Box borderStyle="round" borderColor="white" flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text bold>NOIR</Text>
        <Text dimColor>▪</Text>
        <Text>{provider}</Text>
        <Text dimColor>/</Text>
        <Text>{model}</Text>
        <Box flexGrow={1} />
        {busy ? <Spinner label="thinking" /> : <Text dimColor>·ready·</Text>}
      </Box>
      <Box gap={1}>
        <Text dimColor>ctx</Text>
        <Text>{bar}</Text>
        <Text dimColor>{tokens} tok ({pct}% of {compactAt})</Text>
        <Box flexGrow={1} />
        <Text dimColor>{sessionTitle.slice(0, 28)}</Text>
      </Box>
    </Box>
  );
}

export interface ComposerProps {
  value: string;
  onChange(value: string): void;
  onSubmit(value: string): void;
  onHistory(delta: number): void;
  onAbort(): void;
  busy: boolean;
  placeholder: string;
}

export function Composer({ value, onChange, onSubmit, onHistory, onAbort, busy, placeholder }: ComposerProps): React.ReactElement {
  const [showCursor, setShowCursor] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setShowCursor((x) => !x), 530);
    return () => clearInterval(t);
  }, []);

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.escape && busy) {
      onAbort();
      return;
    }
    if (key.upArrow) {
      onHistory(-1);
      return;
    }
    if (key.downArrow) {
      onHistory(1);
      return;
    }
    if (key.backspace || key.delete) {
      if (key.ctrl) {
        // ctrl+w-ish: delete word
        const parts = value.split(/\s+/);
        parts.pop();
        onChange(parts.join(" "));
      } else {
        onChange(value.slice(0, -1));
      }
      return;
    }
    if (key.tab) {
      return; // handled by App for mode switching
    }
    if (input) {
      onChange(value + input);
    }
  });

  const promptChar = value.startsWith("/") ? "◇" : value.startsWith("!") ? "◆" : "»";
  return (
    <Box borderStyle="round" borderColor="white" paddingX={1}>
      <Text bold>
        {promptChar} {value || placeholder}
      </Text>
      <Text bold>{showCursor ? "█" : " "}</Text>
      <Box flexGrow={1} />
      {busy ? <Text dimColor>esc=abort</Text> : <Text dimColor>enter=send · !=shell · /=cmd</Text>}
    </Box>
  );
}

export interface LogViewProps {
  items: DisplayItem[];
  streaming: string | null;
  height: number;
  scroll: number;
}

export function LogView({ items, streaming, height, scroll }: LogViewProps): React.ReactElement {
  const end = Math.max(0, items.length - scroll * 3);
  const visible = items.slice(Math.max(0, end - height), end);
  return (
    <Box flexDirection="column">
      {visible.map((it) => (
        <ItemView key={it.id} item={it} />
      ))}
      {streaming !== null ? (
        <ItemView item={{ id: -1, kind: "assistant", text: streaming }} streaming />
      ) : null}
    </Box>
  );
}

function ItemView({ item, streaming }: { item: DisplayItem; streaming?: boolean }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text bold>{"❯ "}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Box>
            <Text bold dimColor>
              {"◆ "}
            </Text>
          </Box>
          <Text wrap="wrap">{item.text}</Text>
          {streaming ? <Text bold>█</Text> : null}
        </Box>
      );
    case "tool":
      return (
        <Box marginTop={0}>
          <Text dimColor>{item.text}</Text>
        </Box>
      );
    case "note":
    case "cmd":
    case "shell-out":
      return (
        <Box marginTop={0}>
          <Text dimColor wrap="wrap">
            {item.text}
          </Text>
        </Box>
      );
    default:
      return <Text>{item.text}</Text>;
  }
}

export function PanelView({ title, content, loading }: { title: string; content: string; loading: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="white" paddingX={1} marginTop={1}>
      <Box>
        <Text bold>{title}</Text>
        <Box flexGrow={1} />
        {loading ? <Spinner /> : null}
      </Box>
      <Text wrap="wrap" dimColor={false}>
        {content}
      </Text>
    </Box>
  );
}

export interface FooterProps {
  modes: Array<{ id: string; label: string }>;
  current: string;
  extra: string;
}

export function Footer({ modes, current, extra }: FooterProps): React.ReactElement {
  const left = modes
    .map((m) => (m.id === current ? `[${m.label}]` : ` ${m.label} `))
    .join(" ");
  return (
    <Box borderStyle="round" borderColor="white" paddingX={1}>
      <Text bold>{left}</Text>
      <Box flexGrow={1} />
      <Text dimColor>tab=switch · {extra}</Text>
    </Box>
  );
}
