"""
streamlit_app.py
=================
Streamlit 래퍼 – 빌드된 Vite React 앱을 Streamlit에서 서빙합니다.

사용법 (로컬):
  1. npm run build          # Vite 프론트엔드 프로덕션 빌드
  2. streamlit run streamlit_app.py
"""

import streamlit as st
import streamlit.components.v1 as components
import os
import base64
import re
import subprocess
import sys

# ─────────────────────────────────────────
# 페이지 설정
# ─────────────────────────────────────────
st.set_page_config(
    page_title="일상 무자 – AI 블로그 자동 포스팅",
    page_icon="✨",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# ─────────────────────────────────────────
# 경로 상수
# ─────────────────────────────────────────
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(PROJECT_ROOT, "dist")
INDEX_HTML = os.path.join(DIST_DIR, "index.html")
ASSETS_DIR = os.path.join(DIST_DIR, "assets")


# ─────────────────────────────────────────
# 헬퍼: 파일 → base64 data URI
# ─────────────────────────────────────────
def file_to_data_uri(filepath: str, mime: str) -> str:
    """파일을 읽어서 base64 data URI 문자열로 변환한다."""
    with open(filepath, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("utf-8")
    return f"data:{mime};base64,{encoded}"


def guess_mime(filename: str) -> str:
    """확장자 기반으로 MIME 타입을 추측한다."""
    ext = os.path.splitext(filename)[1].lower()
    mime_map = {
        ".js": "application/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".ttf": "font/ttf",
    }
    return mime_map.get(ext, "application/octet-stream")


# ─────────────────────────────────────────
# 핵심: dist 폴더의 자산을 인라인한 HTML 생성
# ─────────────────────────────────────────
def build_inline_html() -> str:
    """
    dist/index.html을 읽고,
    <script src="/assets/..."> → 인라인 <script>...</script>
    <link href="/assets/..."> → 인라인 <style>...</style>
    형태로 모든 자산을 embed하여 단일 HTML 문자열을 반환한다.
    """
    if not os.path.exists(INDEX_HTML):
        return ""

    with open(INDEX_HTML, "r", encoding="utf-8") as f:
        html = f.read()

    # JS 파일 인라인
    js_pattern = re.compile(
        r'<script\s+type="module"\s+crossorigin\s+src="(/assets/[^"]+\.js)"[^>]*>\s*</script>',
        re.IGNORECASE,
    )
    for match in js_pattern.finditer(html):
        src_path = match.group(1)  # /assets/index-xxx.js
        local_path = os.path.join(DIST_DIR, src_path.lstrip("/"))
        if os.path.exists(local_path):
            with open(local_path, "r", encoding="utf-8") as jf:
                js_content = jf.read()
            # module script 인라인
            inline_tag = f'<script type="module">{js_content}</script>'
            html = html.replace(match.group(0), inline_tag)

    # CSS 파일 인라인
    css_pattern = re.compile(
        r'<link\s+rel="stylesheet"\s+crossorigin\s+href="(/assets/[^"]+\.css)"[^>]*>',
        re.IGNORECASE,
    )
    for match in css_pattern.finditer(html):
        href_path = match.group(1)  # /assets/index-xxx.css
        local_path = os.path.join(DIST_DIR, href_path.lstrip("/"))
        if os.path.exists(local_path):
            with open(local_path, "r", encoding="utf-8") as cf:
                css_content = cf.read()
            inline_tag = f"<style>{css_content}</style>"
            html = html.replace(match.group(0), inline_tag)

    return html


# ─────────────────────────────────────────
# 자동 빌드 확인
# ─────────────────────────────────────────
def ensure_dist_exists():
    """dist 폴더가 없으면 npm run build를 시도한다."""
    if os.path.exists(INDEX_HTML):
        return True

    st.warning("⏳ 빌드된 파일이 없습니다. `npm run build`를 실행합니다...")
    try:
        result = subprocess.run(
            ["npm", "run", "build"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode == 0 and os.path.exists(INDEX_HTML):
            st.success("✅ 빌드 완료!")
            return True
        else:
            st.error(f"빌드 실패:\n```\n{result.stderr}\n```")
            return False
    except FileNotFoundError:
        st.error("npm이 설치되어 있지 않습니다. Node.js를 설치해주세요.")
        return False
    except subprocess.TimeoutExpired:
        st.error("빌드 타임아웃(120초). 수동으로 `npm run build`를 실행해 주세요.")
        return False


# ─────────────────────────────────────────
# Streamlit 커스텀 CSS (Streamlit UI 최소화)
# ─────────────────────────────────────────
def inject_streamlit_style():
    """Streamlit 기본 헤더/푸터/메뉴를 숨기고 전체 화면으로 만든다."""
    st.markdown(
        """
        <style>
            /* Streamlit 기본 요소 숨기기 */
            #MainMenu {visibility: hidden;}
            footer {visibility: hidden;}
            header {visibility: hidden;}
            .stDeployButton {display: none;}

            /* iframe 컨테이너를 꽉 채우기 */
            .stApp {
                background-color: #F8F9FA;
            }
            .element-container iframe {
                border: none !important;
            }
            /* 상하 패딩 최소화 */
            .block-container {
                padding-top: 0 !important;
                padding-bottom: 0 !important;
                max-width: 100% !important;
            }
        </style>
        """,
        unsafe_allow_html=True,
    )


# ─────────────────────────────────────────
# 메인
# ─────────────────────────────────────────
def main():
    inject_streamlit_style()

    if not ensure_dist_exists():
        st.stop()

    inline_html = build_inline_html()
    if not inline_html:
        st.error("인라인 HTML 생성에 실패했습니다. dist 폴더를 확인해 주세요.")
        st.stop()

    # React 앱 렌더링 (전체 높이)
    components.html(inline_html, height=900, scrolling=True)

    # 사이드바: 서버 상태 안내
    with st.sidebar:
        st.markdown("### ⚙️ 서버 안내")
        st.markdown(
            """
            이 화면은 **프리뷰 전용**입니다.

            네이버 자동 포스팅을 실행하려면
            **별도 터미널**에서 백엔드 서버를 실행하세요:

            ```bash
            npm run dev
            ```

            백엔드가 `localhost:3000`에서 실행 중이어야
            '네이버 블로그 자동 포스팅 실행' 버튼이 정상 동작합니다.
            """
        )
        st.divider()
        st.caption("일상 무자 v1.1 · AI Blog Writer")


if __name__ == "__main__":
    main()
