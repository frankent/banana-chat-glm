# Image processing failure — FR-MEDIA-001 / TC-MEDIA-021

Root cause: both Dockerfiles omitted PHP GD. `ProcessAttachment::processImage` called `imagecreatefromstring`, throwing an undefined-function Error. The job caught it and marked the upload failed; the composer then displayed “ประมวลผลไฟล์ไม่สำเร็จ”. Production logs show this exact failure, including 2026-09-10 20:55 UTC.

Reproduction: executing the image decoder directly inside the production worker failed; `extension_loaded('gd')` was false. This rules out filename/MIME, network and S3 failures as the cause of that logged exception. Host PHP upload tests had passed because the host had GD; recent browser viewer fixtures deliberately bypassed processing and did not cover the failing pipeline.

Fix: build GD with PNG/JPEG/GIF/WebP support into dev/CI and production images. Both Dockerfiles now execute `docker/check-media-runtime.php` during the build. The check actually encodes/decodes all four formats and fails if the runtime cannot do so, preventing another image without the required codecs from shipping. No application behavior or database schema change.

Validation: host codec probe passed; API UploadTest passed 23 cases / 119 assertions. `verify-production.mjs` tests real upload → worker processing → generated thumbnail/dimensions → send → recipient thumbnail and original viewer for PNG/JPEG/GIF/WebP. It reads the authorized test-account password from stdin. The fixture images must be generated as `/tmp/banana-qa-image.{png,jpeg,gif,webp}` (320×180); tests send labeled QA messages.
