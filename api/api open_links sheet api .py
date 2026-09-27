#!/usr/bin/env python3
"""
WhatsApp Bulk Message Sender v7.0.0 - Fixed Batch Streaming
-------------------------------------------------------------------
- Uses since_row (server-side) instead of growing exclude list
- Respects has_more flag from server
- Correct total progress calculation
- Fixed continue-on-error infinite loop
- Reliable pause/resume (pynput only)
- Duplicate batch detection
- Server count endpoint
- Idempotent updates
- Big colored banners
"""

import argparse
import logging
import random
import re
import sys
import time
import datetime
import threading
import webbrowser
import requests
from datetime import timedelta
from enum import Enum

import pyautogui
from pynput.keyboard import Key, Listener as KeyboardListener

# ================== Constants ==================
WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyS9uwhOGm_ulpuLr7jjgiUeYC3KZOGY9WAyTvMDQ_AQExvrDFZbK7Ed5_33KloQM8M/exec"
DEFAULT_BATCH_SIZE = 5
DEFAULT_SPEED_TEST_INTERVAL = 20
HTTP_TIMEOUT = 90
MAX_CONSECUTIVE_FETCH_FAILURES = 3


class TermColors:
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    RESET = "\033[0m"


# ================== Errors ==================
class SendErrorType(Enum):
    BROWSER_ERROR = "Browser Error"
    TIMEOUT = "Timeout"
    WHATSAPP_NOT_LOADED = "WhatsApp Not Loaded"
    INVALID_LINK = "Invalid Link"
    SEND_VERIFICATION_FAILED = "Send Verification Failed"
    UNKNOWN = "Unknown Error"


class SendError(Exception):
    def __init__(self, error_type, message=""):
        self.error_type = error_type
        self.message = message
        super().__init__(f"{error_type.value}: {message}")


# ================== Logging ==================
class CustomFormatter(logging.Formatter):
    def format(self, record):
        record.time = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return super().format(record)


def setup_logging(log_file="whatsapp_sender.log"):
    lg = logging.getLogger("WhatsAppSender")
    lg.setLevel(logging.DEBUG)
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(CustomFormatter("[%(time)s] %(levelname)-8s | %(message)s"))
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(message)s"))
    lg.addHandler(fh)
    lg.addHandler(ch)
    return lg


logger = setup_logging()


# ================== Pause Manager ==================
class PauseManager:
    def __init__(self, logger):
        self.paused = False
        self.kill = False
        self.logger = logger
        self.esc_hold_threshold = 2.0
        self.esc_press_time = None
        self.last_toggle_time = 0.0
        self.toggle_cooldown = 0.6
        self.listener = KeyboardListener(on_press=self.on_press, on_release=self.on_release)
        self.listener.start()

    def on_press(self, key):
        if key == Key.esc and self.esc_press_time is None:
            self.esc_press_time = time.time()
        try:
            ch = getattr(key, "char", None)
            if ch:
                if ch.lower() == 'p' and not self.kill:
                    self.toggle_pause()
                elif ch.lower() == 'r' and not self.kill:
                    self.resume()
        except AttributeError:
            pass

    def on_release(self, key):
        if key == Key.esc and self.esc_press_time is not None:
            duration = time.time() - self.esc_press_time
            self.esc_press_time = None
            if duration >= self.esc_hold_threshold:
                self.kill = True
                self.logger.critical(f"[!] EMERGENCY STOP (Esc held {duration:.1f}s)")

    def toggle_pause(self):
        now = time.time()
        if now - self.last_toggle_time < self.toggle_cooldown:
            return
        self.last_toggle_time = now
        self.paused = not self.paused
        if self.paused:
            print(f"\n{TermColors.YELLOW}{TermColors.BOLD}[||] PAUSED. Press 'R' to resume.{TermColors.RESET}\n")
        else:
            print(f"\n{TermColors.GREEN}{TermColors.BOLD}[>] RESUMED.{TermColors.RESET}\n")

    def resume(self):
        now = time.time()
        if now - self.last_toggle_time < self.toggle_cooldown:
            return
        if self.paused:
            self.last_toggle_time = now
            self.paused = False
            print(f"\n{TermColors.GREEN}{TermColors.BOLD}[>] RESUMED.{TermColors.RESET}\n")

    def check_pause(self):
        while self.paused and not self.kill:
            time.sleep(0.3)
        if self.kill:
            raise SystemExit(0)

    def interruptible_sleep(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if self.kill:
                raise SystemExit(0)
            if self.paused:
                self.check_pause()
            time.sleep(0.2)

    def cleanup(self):
        try:
            self.listener.stop()
        except Exception:
            pass


# ================== Human Simulator ==================
class HumanSimulator:
    def __init__(self, delay_min, delay_max):
        self.delay_min = delay_min
        self.delay_max = delay_max
        pyautogui.FAILSAFE = False

    def random_delay(self, pause_mgr=None):
        delay = random.uniform(self.delay_min, self.delay_max)
        if pause_mgr:
            pause_mgr.interruptible_sleep(delay)
        else:
            time.sleep(delay)

    def human_mouse_move(self):
        try:
            w, h = pyautogui.size()
            x, y = pyautogui.position()
            nx = max(0, min(w - 1, x + random.randint(-100, 100)))
            ny = max(0, min(h - 1, y + random.randint(-100, 100)))
            pyautogui.moveTo(nx, ny, duration=random.uniform(0.2, 0.8))
        except Exception as e:
            logger.debug(f"Mouse move failed: {e}")


# ================== Link Validator ==================
class LinkValidator:
    @staticmethod
    def is_valid(link):
        pattern = r"^https://api\.whatsapp\.com/send\?phone=(\d+)(&text=.+)?$"
        m = re.match(pattern, link)
        if not m:
            return False
        phone = m.group(1)
        return phone.isdigit() and (10 <= len(phone) <= 15)


# ================== Speed Checker ==================
class InternetSpeedChecker:
    @staticmethod
    def check_internal(pause_mgr=None):
        logger.info("[*] Measuring speed internally...")
        try:
            res = requests.get(
                "https://speed.cloudflare.com/__down?bytes=1000000",
                timeout=15, stream=True
            )
            start = time.time()
            total = 0
            for chunk in res.iter_content(chunk_size=8192):
                if pause_mgr and pause_mgr.kill:
                    raise SystemExit(0)
                total += len(chunk)
            elapsed = time.time() - start
            if elapsed <= 0:
                return None
            mbps = (total * 8) / (elapsed * 1_000_000)
            logger.info(f"   [OK] Speed: {mbps:.2f} Mbps")
            return mbps
        except SystemExit:
            raise
        except Exception as e:
            logger.warning(f"   [!] Speed test failed: {e}")
            return None

    @staticmethod
    def is_connected():
        for url in ("https://www.google.com", "https://www.cloudflare.com"):
            try:
                requests.get(url, timeout=8)
                return True
            except Exception:
                continue
        return False


# ================== Google Sheet API ==================
class GoogleSheetAPI:
    def __init__(self, url=WEB_APP_URL):
        self.url = url
        self._lock = threading.Lock()

    def fetch_batch(self, msg_type, batch_size=DEFAULT_BATCH_SIZE,
                    exclude_ids=None, since_row=0):
        """
        Fetch a batch using since_row (fast, URL stays short).
        Falls back to exclude_ids if since_row not supported by server.
        """
        if exclude_ids is None:
            exclude_ids = []
        params = {
            "action": "fetch",
            "type": msg_type,
            "limit": batch_size,
        }
        # ✅ الأولوية لـ since_row (URL قصير + أداء أفضل)
        if since_row > 0:
            params["since_row"] = since_row
        elif exclude_ids:
            params["exclude"] = ",".join(str(x) for x in exclude_ids)

        logger.info(f"[*] Fetching batch of {batch_size} '{msg_type}' (since_row={since_row})...")
        try:
            res = requests.get(self.url, params=params, timeout=HTTP_TIMEOUT)
            if res.status_code != 200:
                logger.error(f"[X] HTTP {res.status_code}: {res.text[:200]}")
                return None, False, 0
            data = res.json()
            if not isinstance(data, dict):
                logger.error(f"[X] Unexpected response type: {type(data)}")
                return None, False, 0
            if not data.get("success"):
                logger.error(f"[X] Server error: {data.get('error')}")
                return None, False, 0
            batch = data.get("batch", [])
            has_more = data.get("has_more", False)
            next_suggested = data.get("next_suggested", 0)
            total_pending = data.get("total_pending", 0)
            logger.info(
                f"   [OK] Received {len(batch)} tasks. "
                f"has_more={has_more}, total_pending={total_pending}"
            )
            return batch, has_more, next_suggested
        except requests.exceptions.Timeout:
            logger.error(f"[X] Timeout ({HTTP_TIMEOUT}s)")
            return None, False, 0
        except Exception as e:
            logger.error(f"[X] Fetch error: {e}")
            return None, False, 0

    def fetch_batch_async(self, msg_type, batch_size, since_row, holder):
        """Async fetch using since_row."""
        def _worker():
            try:
                batch, has_more, next_suggested = self.fetch_batch(
                    msg_type, batch_size, since_row=since_row
                )
            except Exception as e:
                logger.error(f"[X] Async worker crashed: {e}")
                batch, has_more, next_suggested = None, False, 0
            with self._lock:
                holder['batch'] = batch
                holder['has_more'] = has_more
                holder['next_suggested'] = next_suggested
                holder['ready'] = True
        t = threading.Thread(target=_worker, daemon=True)
        t.start()
        return t

    def count(self, msg_type):
        try:
            res = requests.get(
                self.url,
                params={"action": "count", "type": msg_type},
                timeout=HTTP_TIMEOUT,
            )
            if res.status_code != 200:
                return None
            data = res.json()
            return data if data.get("success") else None
        except Exception as e:
            logger.debug(f"Count failed: {e}")
            return None

    def update_status(self, row_id, msg_type, status, max_attempts=3):
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        payload = {
            "row_id": row_id,
            "type": msg_type,
            "status": status,
            "timestamp": now_str,
        }
        for attempt in range(1, max_attempts + 1):
            try:
                res = requests.post(self.url, json=payload, timeout=30)
                if res.status_code == 200:
                    data = res.json()
                    if data.get("success"):
                        if data.get("skipped"):
                            logger.info(f"   [i] Row {row_id}: skipped")
                        else:
                            logger.info(f"   [OK] Row {row_id} -> '{status}'")
                        return True
                    logger.warning(f"   [!] Server rejected: {data.get('error')}")
                else:
                    logger.warning(f"   [!] HTTP {res.status_code}")
            except Exception as e:
                logger.warning(f"   [!] Attempt {attempt}/{max_attempts} failed: {e}")
            if attempt < max_attempts:
                time.sleep(2)
        logger.error(f"   [X] Row {row_id} update failed after {max_attempts} attempts")
        return False


# ================== Banners ==================
def print_success_banner(row_id, serial, completed, total):
    total_str = str(total) if total else "?"
    print(
        f"\n{TermColors.GREEN}{TermColors.BOLD}"
        f"╔═══════════════════════════════════════════════╗\n"
        f"║        ✅  MESSAGE SENT SUCCESSFULLY  ✅       ║\n"
        f"╠═══════════════════════════════════════════════╣\n"
        f"║  Row: {row_id:<7} |  Serial: {str(serial):<10}        ║\n"
        f"║  Progress: {completed}/{total_str:<33}║\n"
        f"╚═══════════════════════════════════════════════╝"
        f"{TermColors.RESET}\n"
    )


def print_failure_banner(row_id, error_info):
    err = str(error_info)[:36] if error_info else "Unknown"
    print(
        f"\n{TermColors.RED}{TermColors.BOLD}"
        f"╔═══════════════════════════════════════════════╗\n"
        f"║        ❌  MESSAGE FAILED TO SEND  ❌          ║\n"
        f"╠═══════════════════════════════════════════════╣\n"
        f"║  Row: {row_id:<7}                              ║\n"
        f"║  Error: {err:<38}║\n"
        f"╚═══════════════════════════════════════════════╝"
        f"{TermColors.RESET}\n"
    )


# ================== WhatsApp Sender ==================
class WhatsAppSender:
    def __init__(self, pause_manager, human_sim, msg_type, gsheet,
                 enable_verification=False, close_tabs=False, max_retries=2,
                 wait_time=12, press_count=3, press_interval=3,
                 batch_size=DEFAULT_BATCH_SIZE,
                 speed_test_interval=DEFAULT_SPEED_TEST_INTERVAL,
                 speed_test_mode="internal"):
        self.pause_manager = pause_manager
        self.human_sim = human_sim
        self.msg_type = msg_type
        self.gsheet = gsheet
        self.enable_verification = enable_verification
        self.close_tabs = close_tabs
        self.max_retries = max_retries
        self.wait_time = wait_time
        self.press_count = press_count
        self.press_interval = press_interval
        self.batch_size = batch_size
        self.speed_test_interval = speed_test_interval
        self.speed_test_mode = speed_test_mode

        self.stats = {"success": 0, "failed": 0, "skipped": 0, "unverified": 0}
        self.failed_indices = []
        self.start_time_run = None
        self.total = 0
        self.completed = 0
        self.successful_sent = 0
        self.processed_ids = set()

    def send_task(self, task, index, total):
        self.pause_manager.check_pause()

        row_id = task.get('row_id', index)
        link = task.get('url', '')
        serial = task.get('serial', 'N/A')

        if not LinkValidator.is_valid(link):
            logger.warning(f"[X] Invalid link (row {row_id})")
            self.stats["skipped"] += 1
            self.completed += 1
            self.processed_ids.add(row_id)
            self.gsheet.update_status(row_id, self.msg_type, "FAILED - Invalid link")
            return

        elapsed = time.time() - self.start_time_run
        avg_time = elapsed / self.successful_sent if self.successful_sent > 0 else 0
        remaining = (total - self.completed) * avg_time if total > 0 else 0
        eta_str = str(timedelta(seconds=int(remaining))) if avg_time > 0 else "calculating..."
        progress_pct = (self.completed / total) * 100 if total > 0 else 0
        logger.info(f"[#] Progress: {self.completed}/{total} ({progress_pct:.1f}%) | ETA: {eta_str}")
        logger.info(f"[*] Processing row {row_id} (serial: {serial})...")

        success = False
        error_info = ""
        start_time = datetime.datetime.now()

        for attempt in range(self.max_retries + 1):
            if attempt > 0:
                logger.info(f"   [R] Retry {attempt}/{self.max_retries}")
                self.pause_manager.interruptible_sleep(5)
                self.pause_manager.check_pause()

            try:
                self.human_sim.human_mouse_move()
                webbrowser.open(link, new=2)
                self.pause_manager.check_pause()

                load_delay = random.uniform(self.wait_time, self.wait_time + 3)
                self.pause_manager.interruptible_sleep(load_delay)
                self.pause_manager.check_pause()

                for pr in range(self.press_count):
                    self.pause_manager.check_pause()
                    self.human_sim.human_mouse_move()
                    pyautogui.press('enter')
                    logger.info(f"   [OK] Enter ({pr+1}/{self.press_count})")
                    if pr < self.press_count - 1:
                        self.pause_manager.interruptible_sleep(self.press_interval)

                success = True
                break

            except SendError as e:
                error_info = f"{e.error_type.value}: {e.message}"
                logger.error(f"   [X] {error_info}")
                if attempt == self.max_retries:
                    break
            except SystemExit:
                raise
            except Exception as e:
                error_info = f"{SendErrorType.UNKNOWN.value}: {e}"
                logger.error(f"   [X] {error_info}")
                if attempt == self.max_retries:
                    break

        if success:
            self.stats["success"] += 1
            self.successful_sent += 1
            status_result = "Sent"
            print_success_banner(row_id, serial, self.completed + 1, total)
            if self.close_tabs:
                try:
                    pyautogui.hotkey('ctrl', 'w')
                    time.sleep(0.5)
                except Exception:
                    pass
        else:
            self.stats["failed"] += 1
            self.failed_indices.append((row_id, error_info))
            status_result = f"FAILED: {error_info[:40]}" if error_info else "FAILED"
            print_failure_banner(row_id, error_info)

        self.gsheet.update_status(row_id, self.msg_type, status_result)
        self.completed += 1
        self.processed_ids.add(row_id)

        end_time = datetime.datetime.now()
        duration = (end_time - start_time).total_seconds()
        logger.info(
            f"   [i] Row={row_id} dur={duration:.1f}s "
            f"status={'SUCCESS' if success else 'FAILED'}"
        )

        if (self.speed_test_interval > 0
                and self.completed > 0
                and self.completed % self.speed_test_interval == 0):
            self._run_speed_test()

    def _run_speed_test(self):
        logger.info(f"[i] Speed test (every {self.speed_test_interval} msgs)...")
        if not InternetSpeedChecker.is_connected():
            print(f"\n{TermColors.YELLOW}{TermColors.BOLD}"
                  f"[!] NO INTERNET — waiting for recovery...{TermColors.RESET}\n")
            while not InternetSpeedChecker.is_connected():
                if self.pause_manager.kill:
                    raise SystemExit(0)
                time.sleep(5)
            logger.info("[OK] Internet restored.")
        InternetSpeedChecker.check_internal(self.pause_manager)

    def run(self):
        self.start_time_run = time.time()
        logger.info(f"[>>] Starting (batch_size={self.batch_size})")

        # Get initial count
        count_info = self.gsheet.count(self.msg_type)
        server_total = 0
        if count_info:
            server_total = count_info.get("pending", 0)
            logger.info(
                f"[i] Server: pending={server_total}, "
                f"sent={count_info.get('sent', 0)}, "
                f"failed={count_info.get('failed', 0)}"
            )

        # ✅ إصلاح: total ثابت من السيرفر (لا يتضخم)
        self.total = server_total

        # First batch
        first_batch, first_has_more, first_next = self.gsheet.fetch_batch(
            self.msg_type, self.batch_size, since_row=0
        )
        if first_batch is None:
            logger.error("[X] Failed to fetch first batch.")
            input("\n[i] Press Enter to exit...")
            return
        if not first_batch:
            logger.info("[!] No pending messages.")
            print(f"\n{TermColors.YELLOW}[!] No pending messages.{TermColors.RESET}")
            input("\n[i] Press Enter to exit...")
            return

        # لو count فشل، استخدم طول الدفعة الأولى كتقدير أدنى
        if self.total < len(first_batch):
            self.total = len(first_batch)

        current_batch = first_batch
        next_suggested_row = first_next
        has_more = first_has_more
        batch_number = 0
        consecutive_fetch_failures = 0

        while current_batch:
            batch_number += 1
            logger.info(f"\n{'=' * 50}")
            logger.info(f"[>>] Batch #{batch_number} ({len(current_batch)} messages)")
            logger.info(f"{'=' * 50}")

            # ✅ start async fetch using since_row
            # since_row = آخر صف في الدفعة الحالية (لتخطيها)
            current_last_row = max(
                (t.get('row_id', 0) for t in current_batch),
                default=next_suggested_row
            )

            holder = {'batch': None, 'has_more': False,
                     'next_suggested': 0, 'ready': False}
            next_thread = self.gsheet.fetch_batch_async(
                self.msg_type, self.batch_size,
                since_row=current_last_row,
                holder=holder
            )

            for idx, task in enumerate(current_batch, 1):
                try:
                    self.send_task(task, idx, self.total)
                except SystemExit:
                    raise
                if idx < len(current_batch):
                    self.human_sim.random_delay(self.pause_manager)
                self.pause_manager.check_pause()

            # Wait for async fetch
            next_thread.join(timeout=HTTP_TIMEOUT + 5)
            with self.gsheet._lock:
                next_batch = holder.get('batch')
                next_has_more = holder.get('has_more', False)
                next_suggested = holder.get('next_suggested', 0)
                ready = holder.get('ready', False)

            # ✅ الحالة 1: الـ async فشل → جرب synchronous
            if not ready or next_batch is None:
                consecutive_fetch_failures += 1
                logger.warning(
                    f"[!] Async fetch failed "
                    f"({consecutive_fetch_failures}/{MAX_CONSECUTIVE_FETCH_FAILURES})"
                )
                if consecutive_fetch_failures >= MAX_CONSECUTIVE_FETCH_FAILURES:
                    logger.error("[X] Too many failures. Stopping.")
                    break
                time.sleep(5)
                # retry synchronous with LAST row of current batch
                retry_batch, _, retry_next = self.gsheet.fetch_batch(
                    self.msg_type, self.batch_size,
                    since_row=current_last_row
                )
                if retry_batch is None:
                    # فشل كامل — قرر بناءً على has_more السابق
                    if not has_more:
                        logger.info("[OK] No more pending (last known).")
                        break
                    continue
                next_batch = retry_batch
                next_suggested = retry_next

            consecutive_fetch_failures = 0

            # ✅ الحالة 2: السيرفر رجّع دفعة فاضية
            if not next_batch:
                if has_more:
                    logger.warning("[!] Empty batch but has_more=true. Retrying...")
                    time.sleep(3)
                    retry_batch, _, retry_next = self.gsheet.fetch_batch(
                        self.msg_type, self.batch_size,
                        since_row=current_last_row
                    )
                    if retry_batch:
                        next_batch = retry_batch
                        next_suggested = retry_next
                    else:
                        logger.info("[OK] Confirmed no more pending.")
                        break
                else:
                    logger.info("[OK] No more pending.")
                    break

            # ✅ Duplicate detection
            next_ids = set(t.get('row_id') for t in next_batch if t.get('row_id'))
            overlap = next_ids & self.processed_ids
            if overlap:
                logger.warning(
                    f"[!] Server returned {len(overlap)} already-processed rows. Filtering."
                )
                next_batch = [
                    t for t in next_batch
                    if t.get('row_id') not in self.processed_ids
                ]
                if not next_batch:
                    logger.info("[OK] All returned rows already processed.")
                    break

            # ✅ لا نزيد self.total — السيرفر أعطى العدد الحقيقي
            next_suggested_row = next_suggested
            has_more = next_has_more
            current_batch = next_batch

        # ====== Final Report ======
        logger.info("=" * 50)
        logger.info("[=] Final Statistics:")
        logger.info(f"   [OK] Success:    {self.stats['success']}")
        logger.info(f"   [X]  Failed:     {self.stats['failed']}")
        logger.info(f"   [-]  Skipped:    {self.stats['skipped']}")
        logger.info(f"   [!]  Unverified: {self.stats['unverified']}")

        if self.failed_indices:
            logger.info("   [X] Failed rows:")
            for r_id, err in self.failed_indices:
                logger.info(f"      - Row {r_id}: {err}")
        else:
            logger.info("   [OK] No failures.")

        logger.info(f"   [F] Log: whatsapp_sender.log")
        logger.info("[#] All tasks processed.")
        try:
            input("\n[i] Press Enter to exit...")
        except KeyboardInterrupt:
            pass


# ================== Interactive prompt ==================
def ask_interactive_settings(args):
    if args.wait_time is not None:
        wait_time = args.wait_time
    else:
        try:
            val = input("[?] Seconds to wait for page load? (default 12): ").strip()
            wait_time = float(val) if val else 12.0
            if wait_time < 3:
                wait_time = 3.0
        except (ValueError, EOFError):
            wait_time = 12.0

    if args.press_count is not None:
        press_count = args.press_count
    else:
        try:
            val = input("[?] How many times to press Enter? (default 3): ").strip()
            press_count = int(val) if val else 3
            if press_count < 1:
                press_count = 3
        except (ValueError, EOFError):
            press_count = 3

    return wait_time, press_count


# ================== Main ==================
def main():
    parser = argparse.ArgumentParser(description="WhatsApp Sender v7.0.0")
    parser.add_argument("--delay-min", type=float, default=5.0)
    parser.add_argument("--delay-max", type=float, default=9.0)
    parser.add_argument("--type", type=str, choices=["delay", "collection"])
    parser.add_argument("--close-tabs", action="store_true")
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--skip-verify", action="store_true")
    parser.add_argument("--wait-time", type=float, default=None)
    parser.add_argument("--press-count", type=int, default=None)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--speed-test-interval", type=int, default=DEFAULT_SPEED_TEST_INTERVAL)
    parser.add_argument("--speed-test-mode", type=str,
                        choices=["internal", "browser"], default="internal")
    parser.add_argument("--url", type=str, default=WEB_APP_URL)
    args = parser.parse_args()

    if args.delay_min > args.delay_max:
        logger.error("delay-min > delay-max")
        sys.exit(1)

    msg_type = args.type
    if not msg_type:
        print("=== Select Operation Type ===")
        print("1 - Delay messages")
        print("2 - Collection messages")
        try:
            choice = input("Enter 1 or 2: ").strip()
        except EOFError:
            choice = ""
        msg_type = "delay" if choice == "1" else "collection" if choice == "2" else None

    if not msg_type:
        print("[X] Invalid choice.")
        sys.exit(1)

    gsheet = GoogleSheetAPI(url=args.url)

    print("\n[Config] Interactive settings (Enter for defaults):")
    wait_time, press_count = ask_interactive_settings(args)
    print(f"[OK] wait_time={wait_time}s, press_count={press_count}, batch_size={args.batch_size}")
    print("[Keys] P = Pause, R = Resume, Hold Esc 2s = Emergency Stop\n")

    pause_mgr = PauseManager(logger)
    human_sim = HumanSimulator(args.delay_min, args.delay_max)
    sender = WhatsAppSender(
        pause_manager=pause_mgr,
        human_sim=human_sim,
        msg_type=msg_type,
        gsheet=gsheet,
        enable_verification=False,
        close_tabs=args.close_tabs,
        max_retries=args.max_retries,
        wait_time=wait_time,
        press_count=press_count,
        batch_size=args.batch_size,
        speed_test_interval=args.speed_test_interval,
        speed_test_mode=args.speed_test_mode,
    )

    try:
        print("[!] Make sure WhatsApp Web is logged in.")
        time.sleep(2)
        sender.run()
    except KeyboardInterrupt:
        logger.info("[!] Interrupted.")
    except SystemExit:
        logger.info("[!] Emergency stop.")
    finally:
        pause_mgr.cleanup()
        logger.info("[i] Cleanup done.")


if __name__ == "__main__":
    main()