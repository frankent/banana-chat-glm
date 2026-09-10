<?php

namespace App\Filament\Pages;

use Filament\Pages\Page;
use Illuminate\Support\Facades\Route;

/** FR-ADM-014: live route inventory, no arbitrary API execution or impersonation. */
class ApiCoverage extends Page
{
    protected static ?string $navigationIcon = 'heroicon-o-squares-2x2';

    protected static ?string $navigationGroup = 'System';

    protected static ?string $title = 'Feature coverage';

    protected static string $view = 'filament.pages.api-coverage';

    public function features(): array
    {
        return [
            ['People & workspaces', 'Accounts, roles, access and workspace membership.', '/admin/users'],
            ['Rooms & messages', 'Room recovery, message inspection, history, moderation and export.', '/admin/rooms'],
            ['Notes, pins & replies', 'Inspect notes and attachments; moderate messages and shared pins.', '/admin/room-notes'],
            ['Uploads & media', 'Image, video and file status; retry failed processing.', '/admin/attachments'],
            ['Sessions & notifications', 'Revoke sessions/devices and disable device push delivery.', '/admin/devices'],
            ['AI assistant & group bot', 'Providers, models, quotas, usage and gated conversation review.', '/admin/ai-providers'],
            ['Health & storage', 'Live service checks, failed-job retry and expired-upload cleanup.', '/admin/operations'],
            ['Limits & policies', 'Every runtime setting exposed with typed validation.', '/admin/settings'],
            ['Member experience', 'Chat, typing, search, profile, notification preferences and personal AI memory run under the signed-in member’s permissions.', '/'],
        ];
    }

    public function endpointInventory(): array
    {
        $rows = [];
        foreach (Route::getRoutes() as $r) {
            if (str_starts_with($r->uri(), 'api/v1/')) {
                $rows[] = ['method' => implode('|', array_diff($r->methods(), ['HEAD'])), 'path' => '/'.$r->uri()];
            }
        }usort($rows, fn ($a, $b) => strcmp($a['path'], $b['path']));

        return $rows;
    }
}
