import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Linking } from 'react-native';
import { parseInline, parseMarkdown } from '@banana-chat/chat-core';
import type { MdInlineNode } from '@banana-chat/chat-core';
import { theme } from '../lib/theme';

/**
 * FR-AI-018 / TC-CORE-047 on mobile — the chat-core MarkdownFull parser
 * (typed nodes; React Native escapes every string, so raw HTML/script can
 * never execute). Links open externally via Linking (parser only emits
 * http(s) hrefs).
 */

function InlineNode({ node }: { node: MdInlineNode }) {
  switch (node.type) {
    case 'strong':
      return <Text style={styles.strong}>{node.text}</Text>;
    case 'em':
      return <Text style={styles.em}>{node.text}</Text>;
    case 'code':
      return <Text style={styles.inlineCode}>{node.text}</Text>;
    case 'link':
      return (
        <Text
          style={styles.link}
          onPress={() => {
            void Linking.openURL(node.href);
          }}
        >
          {node.text}
        </Text>
      );
    default:
      return <Text>{node.text}</Text>;
  }
}

function InlineText({ text }: { text: string }) {
  const nodes = parseInline(text);
  if (nodes.length === 1 && nodes[0].type === 'text') {
    return <Text>{nodes[0].text}</Text>;
  }
  return (
    <Text>
      {nodes.map((n, i) => (
        <InlineNode key={i} node={n} />
      ))}
    </Text>
  );
}

export function Markdown({ content }: { content: string }) {
  const blocks = parseMarkdown(content);
  return (
    <View style={styles.stack}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return (
              <Text key={i} style={[styles.text, styles.heading]}>
                <InlineText text={b.text} />
              </Text>
            );
          case 'code':
            return (
              <View key={i} style={styles.codeBlock}>
                <Text style={styles.codeLang}>{b.lang ?? 'text'}</Text>
                <Text style={styles.code}>{b.code}</Text>
              </View>
            );
          case 'list':
            return (
              <View key={i} style={styles.listIndent}>
                {b.items.map((item, j) => (
                  <Text key={j} style={styles.text}>
                    {b.ordered ? `${j + 1}. ` : '• '}
                    <InlineText text={item} />
                  </Text>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={i} style={styles.quote}>
                <Text style={[styles.text, styles.quoteText]}>
                  <InlineText text={b.text} />
                </Text>
              </View>
            );
          case 'table': {
            // no <table> in RN — render rows as aligned monospace lines
            const rows = [b.header, ...b.rows];
            return (
              <View key={i} style={styles.codeBlock}>
                {rows.map((row, j) => (
                  <Text key={j} style={styles.code}>
                    {row.join('  |  ')}
                  </Text>
                ))}
              </View>
            );
          }
          case 'hr':
            return <View key={i} style={styles.hr} />;
          default:
            return (
              <Text key={i} style={[styles.text, styles.paragraph]}>
                <InlineText text={b.text} />
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 6 },
  text: { color: theme.colors.text, fontSize: 15 },
  paragraph: {},
  heading: { fontWeight: '700', fontSize: 16 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  inlineCode: { fontFamily: 'monospace', fontSize: 13, color: theme.colors.danger },
  link: { color: theme.colors.primary, textDecorationLine: 'underline' },
  codeBlock: { backgroundColor: theme.colors.surfaceAlt, borderRadius: 8, padding: 10, gap: 2 },
  codeLang: { color: theme.colors.textMuted, fontSize: 11 },
  code: { fontFamily: 'monospace', fontSize: 13, color: theme.colors.text },
  listIndent: { paddingLeft: 12, gap: 2 },
  quote: { borderLeftWidth: 3, borderLeftColor: theme.colors.border, paddingLeft: 10 },
  quoteText: { color: theme.colors.textMuted },
  hr: { height: 1, backgroundColor: theme.colors.border, marginVertical: 4 },
});
