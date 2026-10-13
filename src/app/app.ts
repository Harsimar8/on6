import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AssetBrowser } from './components/asset-browser/asset-browser';
import { Toolbar } from './components/toolbar/toolbar';
import {Map}from './components/map/map';

// Left panel (Asset Browser + Property Panel) width limits, in pixels.
const SIDEBAR_MIN_PX = 180;
const SIDEBAR_MAX_PX = 700;
const SIDEBAR_DEFAULT_PX = 300;
const LAYOUT_KEY = 'mission-editor.layout';

@Component({
  selector: 'app-root',
  imports: [ Toolbar, AssetBrowser ,Map],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('mission-editor');

  private readonly saved = App.loadLayout();
  protected readonly sidebarWidth = signal<number>(this.saved.sidebarWidth ?? SIDEBAR_DEFAULT_PX);
  protected readonly sidebarCollapsed = signal<boolean>(this.saved.sidebarCollapsed ?? false);
  protected readonly toolbarCollapsed = signal<boolean>(this.saved.toolbarCollapsed ?? false);
  protected readonly dragging = signal(false);

  protected toggleSidebar(): void {
    this.sidebarCollapsed.update(v => !v);
    this.saveLayout();
  }

  protected toggleToolbar(): void {
    this.toolbarCollapsed.update(v => !v);
    this.saveLayout();
  }

  // Drag the splitter to set the left panel's width.
  protected startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const splitter = event.currentTarget as HTMLElement;
    splitter.setPointerCapture(event.pointerId);
    if (this.sidebarCollapsed()) this.sidebarCollapsed.set(false);
    const startX = event.clientX;
    const startWidth = this.sidebarWidth();
    this.dragging.set(true);

    const onMove = (e: PointerEvent) => {
      const width = startWidth + e.clientX - startX;
      this.sidebarWidth.set(Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, width)));
    };
    const onUp = (e: PointerEvent) => {
      splitter.releasePointerCapture(e.pointerId);
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.removeEventListener('pointercancel', onUp);
      this.dragging.set(false);
      this.saveLayout();
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
    splitter.addEventListener('pointercancel', onUp);
  }

  private saveLayout(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        sidebarWidth: this.sidebarWidth(),
        sidebarCollapsed: this.sidebarCollapsed(),
        toolbarCollapsed: this.toolbarCollapsed()
      }));
    } catch { }
  }

  private static loadLayout(): { sidebarWidth?: number; sidebarCollapsed?: boolean; toolbarCollapsed?: boolean } {
    try {
      return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') ?? {};
    } catch {
      return {};
    }
  }
}
