<?php

namespace App\Filament\Pages;

class Dashboard extends \Filament\Pages\Dashboard
{
    protected static string $view = 'filament.pages.dashboard';

    protected static ?string $title = 'Overview';

    protected static ?string $navigationLabel = 'Overview';

    public function getHeading(): string
    {
        return 'Workspace overview';
    }

    public function getSubheading(): ?string
    {
        return 'A clear view of your people, conversations and services.';
    }
}
