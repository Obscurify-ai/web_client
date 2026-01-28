#!/usr/bin/env python3
"""
Render Tera/Jinja2 templates to static HTML files.

This script converts the chat templates to standalone HTML files that can be
served statically without a backend. Template variables are replaced with
sensible defaults for a guest user experience.

Usage:
    python render-static.py [--output-dir dist]

The rendered files will work with any OpenAI-compatible API when configured
via static/js/config.js.
"""

import argparse
import os
import re
import shutil
from pathlib import Path


# Default values for template variables
DEFAULTS = {
    # chat.html
    "logged_in": "false",
    "can_access_frontier": "false",
    "default_free_model": "",
    "default_paid_model": "gpt-4",
    "username": "",

    # chat_nojs.html
    "chat_messages": [],
    "available_models": [],
    "selected_model": "",
    "message_history": "",
    "previous_prompt": "",
}


def render_chat_html(template: str) -> str:
    """Render chat.html template with default values."""

    # Replace the template variable block
    js_block = """    <script>
        // Template variables (defaults for static version)
        const isLoggedIn = false;
        const canAccessFrontier = false;
        const defaultFreeModel = '';
        const defaultPaidModel = 'gpt-4';
        const currentUsername = '';
    </script>"""

    # Find and replace the Tera script block
    pattern = r'<script>\s*// Template variables.*?</script>'
    rendered = re.sub(pattern, js_block, template, flags=re.DOTALL)

    # Replace Tera conditionals for logged_in state (show guest UI)
    # Remove logged-in only content
    rendered = re.sub(
        r'\{%\s*if\s+logged_in\s*%\}.*?\{%\s*else\s*%\}',
        '',
        rendered,
        flags=re.DOTALL
    )
    rendered = re.sub(
        r'\{%\s*endif\s*%\}',
        '',
        rendered
    )

    return rendered


def render_chat_nojs_html(template: str) -> str:
    """Render chat_nojs.html template with default values (empty state)."""

    # For no-JS version, we show the welcome message (empty chat_messages)
    # Replace the messages loop with just the welcome
    pattern = r'\{%\s*if\s+chat_messages\.is_empty\(\)\s*%\}(.*?)\{%\s*else\s*%\}.*?\{%\s*endif\s*%\}'
    match = re.search(pattern, template, flags=re.DOTALL)
    if match:
        welcome_content = match.group(1)
        template = re.sub(pattern, welcome_content, template, flags=re.DOTALL)

    # Replace model select options with a placeholder
    model_options = """<option value="" disabled selected>Configure API in config.js</option>"""
    pattern = r'\{%\s*for\s+model\s+in\s+available_models\s*%\}.*?\{%\s*endfor\s*%\}'
    template = re.sub(pattern, model_options, template, flags=re.DOTALL)

    # Replace other template variables
    template = template.replace('{{ message_history }}', '')
    template = template.replace('{{ previous_prompt }}', '')
    template = template.replace('{{ selected_model }}', '')

    return template


def main():
    parser = argparse.ArgumentParser(
        description='Render Tera templates to static HTML'
    )
    parser.add_argument(
        '--output-dir', '-o',
        default='dist',
        help='Output directory for rendered files (default: dist)'
    )
    args = parser.parse_args()

    # Paths
    script_dir = Path(__file__).parent
    repo_root = script_dir.parent
    templates_dir = repo_root / 'templates'
    static_dir = repo_root / 'static'
    output_dir = repo_root / args.output_dir

    # Create output directory
    output_dir.mkdir(exist_ok=True)

    # Render chat.html
    chat_template = (templates_dir / 'chat.html').read_text()
    chat_rendered = render_chat_html(chat_template)
    (output_dir / 'index.html').write_text(chat_rendered)
    print(f"Rendered: {output_dir / 'index.html'}")

    # Render chat_nojs.html
    nojs_template = (templates_dir / 'chat_nojs.html').read_text()
    nojs_rendered = render_chat_nojs_html(nojs_template)
    (output_dir / 'chat_nojs.html').write_text(nojs_rendered)
    print(f"Rendered: {output_dir / 'chat_nojs.html'}")

    # Copy static files
    output_static = output_dir / 'static'
    if output_static.exists():
        shutil.rmtree(output_static)
    shutil.copytree(static_dir, output_static)
    print(f"Copied: {output_static}")

    print(f"\nDone! Serve the '{args.output_dir}' directory to test:")
    print(f"  npx serve {args.output_dir}")
    print(f"  # or")
    print(f"  python -m http.server 8000 --directory {args.output_dir}")


if __name__ == '__main__':
    main()
