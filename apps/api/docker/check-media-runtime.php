<?php

// TC-MEDIA-021 / FR-MEDIA-001: fail the image build if production cannot
// encode/decode the formats used by ProcessAttachment (including WebP thumbs).
if (!extension_loaded('gd')) {
    throw new RuntimeException('GD is required for image and video thumbnail processing');
}
foreach (['png', 'jpeg', 'gif', 'webp'] as $format) {
    $source = imagecreatetruecolor(8, 6);
    ob_start();
    $ok = ('image'.$format)($source);
    $bytes = ob_get_clean();
    $decoded = $ok ? imagecreatefromstring($bytes) : false;
    if (!$decoded || imagesx($decoded) !== 8 || imagesy($decoded) !== 6) {
        throw new RuntimeException('GD codec unavailable: '.$format);
    }
    imagedestroy($decoded);
    imagedestroy($source);
}
echo "TC-MEDIA-021 PNG/JPEG/GIF/WebP encode/decode passed\n";
