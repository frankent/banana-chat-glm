<?php

namespace App\Domain\Ai;

/**
 * FR-AI-006 — parse the model's memory-extraction reply. Tolerates
 * markdown fences and stray prose around the JSON object; validates
 * categories/importance and clamps lengths.
 */
class MemoryExtractionParser
{
    private const VALID_CATEGORIES = ['profile', 'preference', 'project', 'other'];

    /**
     * @return array{add: list<array{content: string, category: string, importance: int}>, update: list<array{id: string, content: string}>, delete: list<string>}
     */
    public function parse(string $reply): array
    {
        $empty = ['add' => [], 'update' => [], 'delete' => []];

        $json = $this->extractJson($reply);
        if ($json === null) {
            return $empty;
        }

        $decoded = json_decode($json, true);
        if (! is_array($decoded)) {
            return $empty;
        }

        $add = [];
        foreach ((array) ($decoded['add'] ?? []) as $item) {
            if (! is_array($item)) {
                continue;
            }
            $content = mb_substr(trim((string) ($item['content'] ?? '')), 0, 300);
            if ($content === '') {
                continue;
            }
            $category = in_array($item['category'] ?? null, self::VALID_CATEGORIES, true)
                ? (string) $item['category']
                : 'other';
            $add[] = [
                'content' => $content,
                'category' => $category,
                'importance' => min(5, max(1, (int) ($item['importance'] ?? 3))),
            ];
        }

        $update = [];
        foreach ((array) ($decoded['update'] ?? []) as $item) {
            if (is_array($item) && isset($item['id']) && is_string($item['id'])) {
                $content = mb_substr(trim((string) ($item['content'] ?? '')), 0, 300);
                if ($content !== '') {
                    $update[] = ['id' => $item['id'], 'content' => $content];
                }
            }
        }

        $delete = [];
        foreach ((array) ($decoded['delete'] ?? []) as $id) {
            if (is_string($id) && $id !== '') {
                $delete[] = $id;
            }
        }

        return ['add' => $add, 'update' => $update, 'delete' => $delete];
    }

    /**
     * find the outermost {...} even when fenced or wrapped in prose.
     */
    private function extractJson(string $reply): ?string
    {
        $reply = trim($reply);
        if ($reply === '') {
            return null;
        }

        // strip markdown fences ```json ... ```
        if (preg_match('/```(?:json)?\s*(.+?)\s*```/s', $reply, $m)) {
            $reply = $m[1];
        }

        $start = strpos($reply, '{');

        return $start === false ? null : substr($reply, $start, strrpos($reply, '}') - $start + 1);
    }
}
