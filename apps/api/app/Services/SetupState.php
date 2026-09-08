<?php

namespace App\Services;

/**
 * FR-SETUP — first-run state, WordPress-style: the app is "not installed"
 * while there is no usable .env (missing file or empty APP_KEY) and no
 * completion marker. The installer merges operator input into .env and
 * drops the marker; from then on the wizard is locked out.
 */
class SetupState
{
    public function __construct(
        private readonly string $envPath,
        private readonly string $markerPath,
    ) {}

    public static function make(): self
    {
        return new self(
            (string) config('setup.env_path'),
            (string) config('setup.marker_path'),
        );
    }

    /**
     * FR-SETUP — pre-install boots have no APP_KEY (the wizard generates one
     * during install) and typically no reachable Redis for the cache the
     * wizard's rate limiter hits. Left alone, EncryptCookies 500s every web
     * request — including /setup itself. Give uninstalled boots a throwaway
     * key and file-backed cache/session; all of it dies with the process,
     * the real values land in .env via the installer.
     */
    public static function applyPreInstallDefaults(): void
    {
        if (! in_array(config('app.key'), [null, ''], true)) {
            return;
        }

        config([
            'app.key' => 'base64:'.base64_encode(random_bytes(32)),
            'cache.default' => 'file',
            'session.driver' => 'file',
        ]);
    }

    public function isCompleted(): bool
    {
        if (is_file($this->markerPath)) {
            return true;
        }

        if (! is_file($this->envPath)) {
            return false;
        }

        $lines = file($this->envPath, FILE_IGNORE_NEW_LINES) ?: [];

        // explicit "force wizard" switch wins wherever it sits in the file
        foreach ($lines as $line) {
            if (preg_match('/^\s*SETUP_COMPLETED\s*=\s*(\S+)/i', $line, $m)) {
                return ! in_array(strtolower($m[1]), ['false', '0', '""', "''"], true);
            }
        }

        // An env with a generated APP_KEY means a previous install (or a
        // hand-rolled make setup) already configured this instance.
        foreach ($lines as $line) {
            if (preg_match('/^\s*APP_KEY\s*=\s*(\S+)/', $line, $m)) {
                return $m[1] !== '' && $m[1] !== 'base64:';
            }
        }

        return false;
    }

    public function complete(): void
    {
        $dir = dirname($this->markerPath);
        if (! is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        @file_put_contents($this->markerPath, now()->toIso8601String().PHP_EOL);
    }

    public function envWritable(): bool
    {
        if (is_file($this->envPath)) {
            return is_writable($this->envPath);
        }

        $dir = dirname($this->envPath);

        return is_dir($dir) && is_writable($dir);
    }

    /**
     * Merge key => value pairs into the env file, preserving every other
     * line (comments, ordering) untouched. Creates the file when missing.
     *
     * @param  array<string, string|null>  $values
     */
    public function writeEnv(array $values): void
    {
        $lines = is_file($this->envPath)
            ? (file($this->envPath, FILE_IGNORE_NEW_LINES) ?: [])
            : [];

        $out = [];
        $written = [];
        foreach ($lines as $line) {
            if (preg_match('/^\s*([A-Za-z0-9_.]+)\s*=/', $line, $m) && array_key_exists($m[1], $values)) {
                $out[] = $m[1].'='.self::format($values[$m[1]]);
                $written[$m[1]] = true;

                continue;
            }
            $out[] = $line;
        }

        foreach ($values as $key => $value) {
            if (! isset($written[$key])) {
                $out[] = $key.'='.self::format($value);
            }
        }

        // drop a trailing duplicate blank run
        file_put_contents($this->envPath, implode(PHP_EOL, $out).PHP_EOL);
    }

    /**
     * .env formatting: null sentinel, quoted when spaces/#/$ or quotes are
     * involved, inner quotes escaped.
     */
    private static function format(?string $value): string
    {
        if ($value === null) {
            return 'null';
        }

        if ($value === '') {
            return '""';
        }

        if (preg_match('/^"(.*)"$/', $value, $m)) {
            $value = $m[1]; // re-quote below with proper escaping
        }

        $needsQuoting = (bool) preg_match('/[\s#"\'$]/', $value);

        return $needsQuoting ? '"'.str_replace('"', '\\"', $value).'"' : $value;
    }
}
