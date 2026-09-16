<?php

namespace App\Filament\Resources\PublicChatApiKeyResource\Pages;

use App\Filament\Resources\PublicChatApiKeyResource;
use Filament\Resources\Pages\ListRecords;

/**
 * FR-PCHAT-032 / TC-PCHAT-048.
 *
 * NO page-level CreateAction here, on purpose. That omission is usually the bug
 * (see the note at ListAiProviders / UserResource.php:112-115), but here it is
 * the design: issuance is the TABLE header CreateAction registered in
 * PublicChatApiKeyResource::table(), because a page-level create needs a create
 * page and would raw-insert a row with no key_id and no secret_ciphertext.
 *
 * ==== WHY THE SECRET'S RESPONSE CARRIES Cache-Control: no-store ============
 * Filament's Notification::send() does NOT put the plaintext in this
 * component's response. It pushes the body into the server-side session, this
 * component's dehydrate dispatches `notificationsSent`, and the framework's own
 * `notifications` Livewire component then pulls it (session()->pull — so
 * exactly once) and renders it in a SEPARATE /livewire/update request.
 *
 * That separate response is covered because Livewire registers
 * SupportDisablingBackButtonCache globally: its ComponentHook::boot() runs for
 * every component boot and DisableBackButtonCacheMiddleware — pushed onto the
 * HTTP kernel, so it wraps /livewire/update as well as the panel page routes —
 * stamps `no-cache, must-revalidate, no-store, max-age=0, private` plus
 * `Pragma: no-cache` onto the response. TC-PCHAT-048 asserts BOTH the header on
 * a real request and the middleware's global registration, so if that mechanism
 * ever goes away the test fails rather than the secret quietly becoming
 * cacheable.
 *
 * Hardening that does NOT belong to this file: pinning the header to the panel
 * itself rather than inheriting it from Livewire is one line in
 * AdminPanelProvider (panel middleware registered with isPersistent: true, so
 * it also covers Livewire updates). Filed as an out-of-scope change request.
 * ===========================================================================
 */
class ListPublicChatApiKeys extends ListRecords
{
    protected static string $resource = PublicChatApiKeyResource::class;
}
