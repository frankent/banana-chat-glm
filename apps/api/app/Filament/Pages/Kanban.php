<?php

namespace App\Filament\Pages;

use App\Domain\Kanban\BoardService;
use App\Models\KanbanLane;
use App\Models\Workspace;
use Filament\Notifications\Notification;
use Filament\Pages\Page;

/** TASK-ADM-041 / FR-KAN-002: system admin lane management. */
class Kanban extends Page
{
    protected static ?string $navigationIcon = 'heroicon-o-view-columns';

    protected static ?string $navigationGroup = 'Workspaces';

    protected static ?string $title = 'Kanban lanes';

    protected static string $view = 'filament.pages.kanban';

    public string $workspaceId = '';

    public array $lanes = [];

    public string $newName = '';

    public static function canAccess(): bool
    {
        return auth('admin')->user()?->is_system_admin === true;
    }

    public function mount(): void
    {
        $this->workspaceId = Workspace::orderBy('name')->value('id') ?? '';
        $this->loadLanes();
    }

    public function updatedWorkspaceId(): void
    {
        $this->loadLanes();
    }

    public function workspaces()
    {
        return Workspace::orderBy('name')->get(['id', 'name']);
    }

    public function loadLanes(): void
    {
        abort_unless(static::canAccess(), 403);
        if (! $this->workspaceId) {
            $this->lanes = [];

            return;
        }
        Workspace::findOrFail($this->workspaceId);
        app(BoardService::class)->initialize($this->workspaceId);
        $this->lanes = KanbanLane::where('workspace_id', $this->workspaceId)->orderBy('position')->orderBy('id')->get()->toArray();
    }

    public function save(int $index): void
    {
        abort_unless(static::canAccess(), 403);
        $lane = $this->lanes[$index] ?? [];
        try {
            app(BoardService::class)->saveLane(auth('admin')->user(), $this->workspaceId, $lane['id'] ?? '', array_intersect_key($lane, array_flip(['name', 'color', 'position', 'is_done'])));
            $this->loadLanes();
            Notification::make()->title('Lane saved')->success()->send();
        } catch (\Throwable $e) {
            Notification::make()->title($e->getMessage())->danger()->send();
        }
    }

    public function add(): void
    {
        abort_unless(static::canAccess(), 403);
        $this->validate(['newName' => 'required|string|max:60']);
        app(BoardService::class)->saveLane(auth('admin')->user(), $this->workspaceId, null, ['name' => $this->newName]);
        $this->newName = '';
        $this->loadLanes();
    }

    public function remove(int $index): void
    {
        abort_unless(static::canAccess(), 403);
        try {
            app(BoardService::class)->deleteLane(auth('admin')->user(), $this->workspaceId, $this->lanes[$index]['id'] ?? '');
            $this->loadLanes();
        } catch (\Throwable $e) {
            Notification::make()->title($e->getMessage())->danger()->send();
        }
    }
}
