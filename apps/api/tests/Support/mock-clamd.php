<?php

/**
 * Minimal clamd mock for Pest (TC-MEDIA-033..035) — run via Symfony Process:
 *
 *   php tests/Support/mock-clamd.php --port=33199 --infected-marker=EICAR
 *
 * Speaks just enough of the clamd protocol: zPING/zPONG and zINSTREAM with
 * 4-byte big-endian chunk framing. A payload containing --infected-marker
 * gets the "FOUND" verdict, everything else is "stream: OK".
 */
$port = 33199;
$marker = 'EICAR';

foreach (array_slice($argv, 1) as $arg) {
    if (str_starts_with($arg, '--port=')) {
        $port = (int) substr($arg, 7);
    }
    if (str_starts_with($arg, '--infected-marker=')) {
        $marker = substr($arg, 18);
    }
}

$server = @stream_socket_server("tcp://127.0.0.1:{$port}", $errno, $errstr);
if ($server === false) {
    fwrite(STDERR, "mock-clamd: cannot listen on {$port}: {$errstr}\n");
    exit(1);
}
fwrite(STDOUT, "mock-clamd: listening on {$port}\n");

while ($conn = @stream_socket_accept($server, 300)) {
    $command = '';
    while (($byte = fread($conn, 1)) !== false && $byte !== "\0" && $byte !== '') {
        $command .= $byte;
        if (strlen($command) > 64) {
            break;
        }
    }

    if ($command === 'zPING') {
        fwrite($conn, "PONG\0");
        fclose($conn);

        continue;
    }

    if ($command === 'zINSTREAM') {
        $payload = '';
        while (true) {
            $lenBytes = fread($conn, 4);
            if ($lenBytes === false || strlen($lenBytes) < 4) {
                break;
            }
            $len = unpack('N', $lenBytes)[1];
            if ($len === 0) {
                break;
            }
            $remaining = $len;
            while ($remaining > 0) {
                $part = fread($conn, $remaining);
                if ($part === false || $part === '') {
                    break 2;
                }
                $payload .= $part;
                $remaining -= strlen($part);
            }
        }

        $verdict = str_contains($payload, $marker)
            ? "stream: Eicar-Signature FOUND\0"
            : "stream: OK\0";
        fwrite($conn, $verdict);
        fclose($conn);

        continue;
    }

    fwrite($conn, "UNKNOWN COMMAND\0");
    fclose($conn);
}
