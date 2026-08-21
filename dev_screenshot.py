import re
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5055"
OUT = "/home/claude/screens"

import os
os.makedirs(OUT, exist_ok=True)


def login(page, username, password):
    page.goto(f"{BASE}/login")
    page.fill('input[name="username"]', username)
    page.fill('input[name="password"]', password)
    page.click('button[type="submit"]')
    page.wait_for_load_state("networkidle")


def logout(page):
    with page.expect_navigation(wait_until="networkidle"):
        page.click('form[action$="/logout"] button[type="submit"]')
    # Land on /login (or wherever logout redirects) before the caller
    # tries to fill in the next role's credentials.
    page.wait_for_selector('input[name="username"]', timeout=10000)


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 1000})
    errors = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

    # --- Admin: reports page (Technician Workload & Performance) ---
    login(page, "admin1", "Admin@12345")
    page.goto(f"{BASE}/reports/")
    page.wait_for_load_state("networkidle")
    page.screenshot(path=f"{OUT}/01_reports_workload.png", full_page=True)

    # --- Admin: issue detail with assignment history + long resolution notes ---
    page.goto(f"{BASE}/issues/2")
    page.wait_for_load_state("networkidle")
    page.screenshot(path=f"{OUT}/02_issue_detail_history.png", full_page=True)

    # logout
    logout(page)

    # --- tech1: dashboard/index (assigned issues, view on map) ---
    login(page, "tech1", "Tech@12345")
    page.goto(f"{BASE}/technician/")
    page.wait_for_load_state("networkidle")
    page.screenshot(path=f"{OUT}/03_technician_index.png", full_page=True)

    # --- tech1: history page populated ---
    page.goto(f"{BASE}/technician/history")
    page.wait_for_load_state("networkidle")
    page.screenshot(path=f"{OUT}/04_technician_history.png", full_page=True)

    logout(page)

    # --- tech2: history empty state (no profile) ---
    login(page, "tech2", "Tech@12345")
    page.goto(f"{BASE}/technician/history")
    page.wait_for_load_state("networkidle")
    page.screenshot(path=f"{OUT}/05_technician_history_empty.png", full_page=True)

    page.goto(f"{BASE}/technician/")
    page.wait_for_load_state("networkidle")
    page.screenshot(path=f"{OUT}/06_technician_index_no_profile.png", full_page=True)

    logout(page)

    # --- GeoMap click-through with issue focus, real CSS this time ---
    login(page, "tech1", "Tech@12345")
    page.goto(f"{BASE}/naps/map?issue_id=1")
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/07_geomap_focus.png", full_page=True)

    browser.close()
    print("Console errors seen:", errors)
    print("Done.")
