<?php

use App\Http\Controllers\SetupController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

// FR-SETUP-002 — WordPress-style first-run wizard (plain blade, no build step)
Route::get('/setup', [SetupController::class, 'index'])->name('setup.wizard');
