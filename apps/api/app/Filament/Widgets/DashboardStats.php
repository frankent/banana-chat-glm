<?php

namespace App\Filament\Widgets;

use App\Models\Message;
use App\Models\Room;
use App\Models\User;
use App\Models\Workspace;
use Filament\Widgets\StatsOverviewWidget as BaseWidget;
use Filament\Widgets\StatsOverviewWidget\Stat;

class DashboardStats extends BaseWidget
{
    protected static bool $isLazy = false;

    protected function getStats(): array
    {
        return [
            Stat::make('ผู้ใช้', User::query()->where('status', 'active')->count())
                ->description(User::query()->where('is_system_admin', true)->count().' system admins')
                ->icon('heroicon-o-users'),
            Stat::make('Workspaces', Workspace::query()->where('status', 'active')->count())
                ->description(Workspace::query()->where('status', 'archived')->count().' archived')
                ->icon('heroicon-o-building-office-2'),
            Stat::make('ห้องทั้งหมด', Room::query()->whereNull('deleted_at')->count())
                ->icon('heroicon-o-chat-bubble-left-right'),
            Stat::make('ข้อความ', Message::query()->count())
                ->icon('heroicon-o-envelope'),
        ];
    }
}
