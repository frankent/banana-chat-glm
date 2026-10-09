<?php

namespace App\Domain\LinkPreview;

/**
 * FR-MSG-013 B3 #4 — metadata extraction. DOMDocument with libxml network and
 * entity features off; output is PLAIN TEXT only (the client renders text nodes).
 */
class OgParser
{
    public const TITLE_MAX = 200;

    public const DESCRIPTION_MAX = 400;

    public const SITE_MAX = 100;

    /**
     * @return array{title:?string, description:?string, site_name:?string, image:?string}
     */
    public function parse(string $html, string $baseUrl, ?string $charset = null): array
    {
        $empty = ['title' => null, 'description' => null, 'site_name' => null, 'image' => null];
        if (trim($html) === '') {
            return $empty;
        }
        if ($charset !== null && ! in_array(strtolower($charset), ['utf-8', 'utf8'], true)) {
            try {
                $conv = @mb_convert_encoding($html, 'UTF-8', $charset);
                $html = is_string($conv) ? $conv : $html;
            } catch (\Throwable) {
                // mbstring does not know every label (TIS-620, windows-874 ...): try iconv, else keep raw bytes
                $conv = @iconv($charset, 'UTF-8//IGNORE', $html);
                $html = is_string($conv) ? $conv : $html;
            }
        }

        $prev = libxml_use_internal_errors(true);
        $doc = new \DOMDocument;
        try {
            // No LIBXML_NOENT / DTDLOAD: entities stay unexpanded, no external fetches.
            $loaded = $doc->loadHTML('<?xml encoding="UTF-8">'.$html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING | LIBXML_COMPACT);
        } catch (\Throwable) {
            $loaded = false;
        } finally {
            libxml_clear_errors();
            libxml_use_internal_errors($prev);
        }
        if (! $loaded) {
            return $empty;
        }

        $meta = [];
        foreach ($doc->getElementsByTagName('meta') as $m) {
            $key = strtolower(trim($m->getAttribute('property') ?: $m->getAttribute('name')));
            $content = $m->getAttribute('content');
            if ($key !== '' && $content !== '' && ! isset($meta[$key])) {
                $meta[$key] = $content;
            }
        }
        $titleTag = null;
        foreach ($doc->getElementsByTagName('title') as $t) {
            $titleTag = $t->textContent;
            break;
        }
        $host = parse_url($baseUrl, PHP_URL_HOST) ?: null;

        $image = null;
        $imgRaw = $meta['og:image'] ?? $meta['og:image:url'] ?? $meta['twitter:image'] ?? null;
        if (is_string($imgRaw) && trim($imgRaw) !== '') {
            $abs = HostPolicy::resolveReference($baseUrl, html_entity_decode(trim($imgRaw)));
            if ($abs !== null && preg_match('#^https?://#i', $abs) === 1 && strlen($abs) <= 2048) {
                $image = $abs;
            }
        }

        return [
            'title' => self::clean($meta['og:title'] ?? $meta['twitter:title'] ?? $titleTag, self::TITLE_MAX),
            'description' => self::clean($meta['og:description'] ?? $meta['twitter:description'] ?? $meta['description'] ?? null, self::DESCRIPTION_MAX),
            'site_name' => self::clean($meta['og:site_name'] ?? null, self::SITE_MAX) ?? self::clean($host, self::SITE_MAX),
            'image' => $image,
        ];
    }

    private static function clean(?string $value, int $max): ?string
    {
        if ($value === null) {
            return null;
        }
        if (! mb_check_encoding($value, 'UTF-8')) {
            $value = mb_convert_encoding($value, 'UTF-8', 'UTF-8');
        }
        $value = strip_tags($value);
        $value = preg_replace('/[\x00-\x08\x0B-\x1F\x7F\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $value) ?? '';
        $value = trim(preg_replace('/\s+/u', ' ', $value) ?? '');
        if ($value === '') {
            return null;
        }

        return mb_substr($value, 0, $max);
    }
}
