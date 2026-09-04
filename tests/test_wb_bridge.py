# -*- coding: utf-8 -*-
"""Unit tests for wb_bridge pure logic (no WorkBuddy DB / network needed)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import wb_bridge  # noqa: E402


class TestParseArgs(unittest.TestCase):
    def test_parse_in_out(self):
        self.assertEqual(
            wb_bridge.parse_args(['--in', 'a.json', '--out', 'b.json']),
            {'in': 'a.json', 'out': 'b.json'},
        )

    def test_empty(self):
        self.assertEqual(wb_bridge.parse_args([]), {})

    def test_dangling_flag_ignored(self):
        self.assertEqual(wb_bridge.parse_args(['--in']), {})


class TestDesktopModelLabels(unittest.TestCase):
    """The label map must cover the desktop app's current builtin lineup."""

    def test_current_lineup_covered(self):
        for mid in ('hy3', 'hy4-preview', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2'):
            self.assertIn(mid, wb_bridge.WB_BUILTIN_LABELS)

    def test_labels_carry_pricing_or_free_tag(self):
        self.assertIn('限时免费', wb_bridge.WB_BUILTIN_LABELS['hy3'])
        self.assertIn('0.79x', wb_bridge.WB_BUILTIN_LABELS['glm-5.3'])


class TestEmit(unittest.TestCase):
    def test_emit_to_file_is_utf8_json(self):
        p = os.path.join(os.path.dirname(__file__), 'out_test.json')
        try:
            wb_bridge.emit({'ok': True, 'text': '中文断言'}, p)
            with open(p, encoding='utf-8') as f:
                data = json.load(f)
            self.assertTrue(data['ok'])
            self.assertEqual(data['text'], '中文断言')
        finally:
            if os.path.exists(p):
                os.remove(p)

    def test_emit_stdout_fallback(self):
        # no out_path -> goes to stdout (reconfigured to utf-8 replace in main)
        wb_bridge.emit({'ok': False, 'reason': 'x'})


class TestCustomModelMatching(unittest.TestCase):
    def test_call_custom_rejects_unknown_model(self):
        out = os.path.join(os.path.dirname(__file__), 'out_call.json')
        try:
            # models.json on the test machine may or may not exist; either way an
            # unknown model id must come back as a structured failure, not a raise.
            wb_bridge.call_custom({'model': 'no-such-model-xyz', 'prompt': 'hi'}, out)
            with open(out, encoding='utf-8') as f:
                data = json.load(f)
            self.assertFalse(data['ok'])
        finally:
            if os.path.exists(out):
                os.remove(out)


if __name__ == '__main__':
    unittest.main()
