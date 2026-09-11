import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const root = new URL("../../../../", import.meta.url).pathname;
const { chromium, expect } = createRequire(root + "apps/web/package.json")(
  "@playwright/test",
);
const prod = process.env.KANBAN_QA_PRODUCTION === "1";
const base = prod ? "https://chat.gamecoms.net" : "http://127.0.0.1:5173";
function php(code) {
  return execFileSync(
    prod ? "ssh" : "docker",
    prod
      ? [
          "-S",
          "/tmp/banana-kanban-ssh",
          "root@165.22.63.119",
          "cd /opt/banana-chat && docker compose --env-file infra/.env -f infra/docker-compose.prod.yml exec -T api php",
        ]
      : ["exec", "-i", "-w", "/app", "banana-chat-kanban-review", "php"],
    {
      input: `<?php require '/app/vendor/autoload.php';$app=require '/app/bootstrap/app.php';$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();${code}`,
      encoding: "utf8",
    },
  );
}
const prefix = "kanimg" + Date.now(),
  password = randomBytes(20).toString("hex");
const fixture = JSON.parse(
  php(
    `$w=App\\Models\\Workspace::create(['slug'=>'${prefix}','name'=>'Image review','status'=>'active']);$users=[];foreach(['Alex Designer','Sam Reviewer'] as $i=>$name){$u=App\\Models\\User::create(['username'=>'${prefix}'.$i,'display_name'=>$name,'password_hash'=>Illuminate\\Support\\Facades\\Hash::make('${password}'),'must_change_password'=>false,'status'=>'active','locale'=>'en']);$w->members()->attach($u->id,['role'=>'owner']);$users[]=$u->username;}echo json_encode(['workspace'=>$w->id,'users'=>$users]);`,
  ),
);
const browser = await chromium.launch();
const errors = [],
  results = [];
const out = new URL("./", import.meta.url).pathname;
async function page(index) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  if (!prod)
    await context.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      url.host = "localhost:18000";
      const response = await route.fetch({ url: url.toString() });
      await route.fulfill({ response });
    });
  context.setDefaultTimeout(15000);
  const p = await context.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(base + "/login");
  await p.getByLabel("Username").fill(fixture.users[index]);
  await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(p.locator("aside").first()).toBeVisible();
  await p.goto(base + "/board");
  await expect(
    p.getByRole("button", { name: "+ Create ticket" }),
  ).toBeEnabled();
  return p;
}
function pass(id) {
  results.push({ id, passed: true });
  console.log("PASS", id);
}
try {
  const a = await page(0),
    b = await page(1);
  const png = Buffer.from(
    await a.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = 280;
      const x = c.getContext("2d");
      x.fillStyle = "#81956b";
      x.fillRect(0, 0, 480, 280);
      x.fillStyle = "white";
      x.font = "28px sans-serif";
      x.fillText("Ticket image QA", 80, 140);
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  const file = (name) => ({ name, mimeType: "image/png", buffer: png });
  await a.getByRole("button", { name: "+ Create ticket" }).click();
  await a
    .getByLabel("Title", { exact: true })
    .fill("Design review with images");
  await a
    .getByLabel("Description", { exact: true })
    .fill("Design requirements");
  await a
    .getByLabel("Description", { exact: true })
    .evaluate((el) => el.setSelectionRange(0, 19));
  await a.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(a.getByLabel("Description", { exact: true })).toHaveValue(
    "**Design requirements**",
  );
  await a
    .getByLabel("Description", { exact: true })
    .fill(
      "## Release design\n\n**Review these images**\n\n- Desktop\n- Mobile\n\n[Reference](https://example.com)\n\n```js\nconst ready = true;\n```",
    );
  await a.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(a.getByLabel("Markdown preview").locator("strong")).toHaveText(
    "Review these images",
  );
  await expect(a.getByLabel("Markdown preview").locator("li")).toHaveCount(2);
  await a.getByRole("button", { name: "Write", exact: true }).click();
  await a
    .getByLabel("Add ticket images")
    .setInputFiles([
      file("desktop.png"),
      file("mobile.png"),
      file("detail.png"),
    ]);
  await expect(
    a.locator(".bc-ticket-image [role=status]").filter({ hasText: "Ready" }),
  ).toHaveCount(3, { timeout: 60000 });
  await a.screenshot({
    path: out + (prod ? "production-" : "") + "editor.png",
    fullPage: true,
  });
  await a.getByRole("button", { name: "Save ticket", exact: true }).click();
  await expect(
    a.getByRole("button", { name: "Edit ticket", exact: true }),
  ).toBeVisible();
  await expect(a.locator("[data-testid=attachment-image]")).toHaveCount(3);
  await expect.poll(() => a.locator("[data-testid=attachment-image]").evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
  const ticketUrl = a.url();
  pass("TC-KAN-013 multi-image upload and Markdown save");
  await a.reload();
  await expect(a.locator("[data-testid=attachment-image]")).toHaveCount(3);
  await expect.poll(() => a.locator("[data-testid=attachment-image]").evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
  await a
    .getByRole("button", { name: "View desktop.png", exact: true })
    .click();
  await expect(a.locator(".bc-viewer-content img")).toBeVisible();
  await a.keyboard.press("Escape");
  await b.goto(ticketUrl);
  await expect(b.locator("[data-testid=attachment-image]")).toHaveCount(3);
  await b.getByRole("button", { name: "Edit ticket", exact: true }).click();
  await b
    .getByRole("button", { name: "Remove mobile.png", exact: true })
    .click();
  await b.getByLabel("Add ticket images").setInputFiles([file("revised.png")]);
  await expect(
    b.locator(".bc-ticket-image [role=status]").filter({ hasText: "Ready" }),
  ).toHaveCount(1, { timeout: 60000 });
  await b.getByRole("button", { name: "Save ticket", exact: true }).click();
  await expect(
    b.getByRole("button", { name: "View revised.png", exact: true }),
  ).toBeVisible();
  await a.reload();
  await expect(
    a.getByRole("button", { name: "View revised.png", exact: true }),
  ).toBeVisible();
  await expect(
    a.getByRole("button", { name: "View mobile.png", exact: true }),
  ).toHaveCount(0);
  pass("TC-KAN-013 peer preserves removes and adds images");
  await a.screenshot({
    path: out + (prod ? "production-" : "") + "ticket.png",
    fullPage: true,
  });
  await a.getByRole("button", { name: "Edit ticket", exact: true }).click();
  await a
    .getByLabel("Add ticket images")
    .setInputFiles({
      name: "bad.png",
      mimeType: "image/png",
      buffer: Buffer.from("not an image"),
    });
  await expect(a.locator(".bc-ticket-image [role=alert]")).toBeVisible({
    timeout: 60000,
  });
  await expect(
    a.getByRole("button", { name: "Save ticket", exact: true }),
  ).toBeDisabled();
  await a.getByRole("button", { name: "Remove bad.png", exact: true }).click();
  await expect(
    a.getByRole("button", { name: "Save ticket", exact: true }),
  ).toBeEnabled();
  await a.getByRole("button", { name: "Cancel", exact: true }).click();
  pass("TC-KAN-013 invalid image recovery");
  await a.setViewportSize({ width: 390, height: 844 });
  await a.screenshot({
    path: out + (prod ? "production-" : "") + "mobile.png",
    fullPage: true,
  });
  await expect(
    a.getByRole("button", { name: "View desktop.png", exact: true }),
  ).toBeVisible();
  await a.getByRole("button", { name: "Edit ticket", exact: true }).click();
  await a.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(a.getByLabel("Markdown preview")).toBeVisible();
  pass("TC-KAN-013 mobile gallery and Markdown preview");
  expect(errors).toEqual([]);
  pass("TC-KAN-013 no runtime errors");
} catch (error) {
  for (const [i, c] of browser.contexts().entries())
    for (const p of c.pages()) {
      await p.screenshot({ path: out + "failure-" + i + ".png" });
      console.log((await p.locator("body").innerText()).slice(-3000));
    }
  throw error;
} finally {
  await browser.close();
  php(
    `$w=App\\Models\\Workspace::where('id','${fixture.workspace}')->where('slug','${prefix}')->firstOrFail();$ids=$w->allMemberships()->pluck('user_id');$attachments=App\\Models\\Attachment::withoutGlobalScopes()->where('workspace_id',$w->id)->get();foreach($attachments as $a){foreach(array_merge([$a->storage_key],array_values($a->derived??[])) as $key)Illuminate\\Support\\Facades\\Storage::disk(config('filesystems.default'))->delete($key);}$w->delete();App\\Models\\User::whereIn('id',$ids)->where('username','like','${prefix}%')->delete();`,
  );
  await writeFile(
    out + (prod ? "production-results.json" : "results.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
}
