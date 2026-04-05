import React, { useState, useCallback, useMemo } from 'react';
import { useDropzone, FileRejection } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Camera, 
  MapPin, 
  Target, 
  FileText, 
  Send, 
  Loader2, 
  CheckCircle2, 
  X, 
  Plus,
  ExternalLink,
  Sparkles
} from 'lucide-react';
import { cn } from './lib/utils';
import { LOCATIONS, PURPOSES, UserInput, BlogPost } from './types';
import { generateBlogPost } from './services/geminiService';
import axios from 'axios';

const MAX_IMAGES = 10;

interface StructuredSectionDraft {
  subtitle: string;
  body: string;
  keywords: string[];
}

interface QuoteSectionDraft {
  quote: string;
  philosopher: string;
}

function validateImages(imageList: string[]) {
  if (imageList.length > MAX_IMAGES) {
    alert('첨부 가능한 사진은 최대 10장까지입니다.');
    return false;
  }

  if (imageList.length === 0) {
    alert('최소 1장 이상의 사진을 선택해주세요.');
    return false;
  }

  return true;
}

function calculatePostInfo(imageCount: number) {
  const sectionCount = imageCount;
  const quoteChars = 60;
  const sectionChars = 115;
  const hashtagChars = 90;

  return {
    sectionCount,
    totalChars: quoteChars + sectionChars * sectionCount + hashtagChars,
  };
}

function normalizeBodyWithSentenceBreaks(body: string) {
  const normalized = body.replace(/\s+/g, ' ').trim();
  const PREFERRED_MIN = 60;
  const PREFERRED_MAX = 80;
  const HARD_MAX = 160;
  let limited = normalized;

  if (normalized.length > PREFERRED_MAX) {
    const preferredWindow = normalized.slice(PREFERRED_MIN, PREFERRED_MAX + 1);
    const preferredSentenceEndOffset = preferredWindow.search(/[.!?。！？]/);
    if (preferredSentenceEndOffset >= 0) {
      limited = normalized.slice(0, PREFERRED_MIN + preferredSentenceEndOffset + 1).trim();
    } else {
      const extendedWindow = normalized.slice(PREFERRED_MAX, HARD_MAX + 1);
      const extendedSentenceEndOffset = extendedWindow.search(/[.!?。！？]/);
      if (extendedSentenceEndOffset >= 0) {
        // 기본 범위(60~80)로 문장 마무리가 어려운 경우에만 160자까지 확장
        limited = normalized.slice(0, PREFERRED_MAX + extendedSentenceEndOffset + 1).trim();
      } else if (normalized.length > HARD_MAX) {
        const hardLimited = normalized.slice(0, HARD_MAX).trim();
        const lastSpace = hardLimited.lastIndexOf(' ');
        limited = lastSpace >= PREFERRED_MIN ? hardLimited.slice(0, lastSpace).trim() : hardLimited;
      } else {
        limited = normalized;
      }
    }
  }

  const paddingPool = [
    ' 오늘의 공기가 한층 더 포근하게 느껴졌다.',
    ' 작은 장면 하나가 오래 마음에 남았다.',
    ' 익숙한 풍경도 새롭게 보이는 순간이었다.',
  ];
  let paddingIndex = 0;
  while (limited.length < PREFERRED_MIN && paddingIndex < 10) {
    const pad = paddingPool[paddingIndex % paddingPool.length];
    const available = PREFERRED_MAX - limited.length;
    if (available <= 0) break;
    limited = `${limited}${pad.slice(0, available)}`.trim();
    paddingIndex += 1;
  }

  return limited.replace(/([.!?。！？])\s*/g, '$1\n').replace(/\n{2,}/g, '\n').trim();
}

function normalizeQuoteText(quote: string) {
  return quote.replace(/^["'“”]+|["'“”]+$/g, '').trim();
}

const DASH_CHAR_CLASS = '[-‐‑‒–—―−]';
const STRICT_DASH_AUTHOR_REGEX = new RegExp(`^${DASH_CHAR_CLASS}\\s*([^\\-‐‑‒–—―−]+?)\\s*${DASH_CHAR_CLASS}$`, 'u');
const LOOSE_DASH_AUTHOR_REGEX = new RegExp(`${DASH_CHAR_CLASS}\\s*([^\\-‐‑‒–—―−]+?)\\s*${DASH_CHAR_CLASS}`, 'u');
const STRIP_DASH_AUTHOR_REGEX = new RegExp(`${DASH_CHAR_CLASS}\\s*[^\\-‐‑‒–—―−]+?\\s*${DASH_CHAR_CLASS}`, 'gu');

function isStandaloneQuoteMarker(line: string) {
  return /^["'“”‘’\s]+$/.test(line.trim());
}

function extractPhilosopherName(line: string) {
  const strictMatch = line.match(STRICT_DASH_AUTHOR_REGEX);
  if (strictMatch?.[1]) return strictMatch[1].trim();

  const looseMatch = line.match(LOOSE_DASH_AUTHOR_REGEX);
  return (looseMatch?.[1] || '').trim();
}

function parseQuoteSection(rawQuote: string): QuoteSectionDraft {
  const cleaned = rawQuote.trim();
  const lines = cleaned.split('\n').map((line) => line.trim()).filter(Boolean);
  const merged = lines.join(' ').replace(/\s+/g, ' ').trim();

  const linePhilosopher =
    lines.find((line) => STRICT_DASH_AUTHOR_REGEX.test(line)) ||
    lines.find((line) => LOOSE_DASH_AUTHOR_REGEX.test(line)) ||
    '';
  const philosopher = extractPhilosopherName(linePhilosopher) || '작자 미상';

  const quoteLineCandidates = lines
    .filter((line) => line !== linePhilosopher)
    .filter((line) => !isStandaloneQuoteMarker(line))
    .map((line) => normalizeQuoteText(line))
    .filter(Boolean);

  let quoteCandidate = quoteLineCandidates.join(' ').replace(/\s+/g, ' ').trim();
  if (!quoteCandidate) {
    const stripped = merged
      .replace(STRIP_DASH_AUTHOR_REGEX, ' ')
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    quoteCandidate = normalizeQuoteText(stripped);
  }
  if (!quoteCandidate) quoteCandidate = '오늘의 순간을 기록하는 마음으로 하루를 담아봅니다.';

  return { quote: quoteCandidate, philosopher };
}

function extractKeywords(text: string, maxCount = 3) {
  const stopwords = new Set([
    '오늘',
    '우리',
    '그리고',
    '그러나',
    '정말',
    '조금',
    '그냥',
    '이렇게',
    '저렇게',
    '무척',
    '가장',
    '정도',
    '이번',
    '하루',
    '순간',
    '느낌',
    '기분',
    '사진',
    '기록',
    '장면',
  ]);

  const tokens = text
    .replace(/[^0-9A-Za-z가-힣\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopwords.has(token));

  const counts = new Map<string, number>();
  tokens.forEach((token) => {
    counts.set(token, (counts.get(token) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([token]) => token)
    .slice(0, maxCount);
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSection(sectionText: string, index: number): StructuredSectionDraft {
  const lines = sectionText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const firstLine = lines[0] || `소제목 ${index + 1}`;
  const subtitle = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^■\s*/, '')
    .replace(/\s*■$/, '')
    .replace(/^소제목[:：]?\s*/i, '')
    .trim() || `소제목 ${index + 1}`;

  let body = lines.slice(1).join(' ').trim();
  if (!body) {
    body = sectionText
      .replace(firstLine, '')
      .replace(/^본문[:：]?\s*/i, '')
      .trim();
  }
  if (!body) body = `${subtitle}의 순간을 담은 장면입니다. 오늘의 분위기와 감정을 기록합니다.`;

  return {
    subtitle,
    body: normalizeBodyWithSentenceBreaks(body),
    keywords: extractKeywords(body, 3),
  };
}

function buildStructuredSections(sections: string[], imageCount: number): StructuredSectionDraft[] {
  const parsed = sections.map((section, idx) => parseSection(section, idx));
  if (parsed.length >= imageCount) return parsed.slice(0, imageCount);

  const filled = [...parsed];
  while (filled.length < imageCount) {
    const idx = filled.length;
    filled.push({
      subtitle: `소제목 ${idx + 1}`,
      body: '사진의 분위기와 장면을 중심으로 오늘의 기록을 정리합니다.',
      keywords: ['사진', '분위기', '기록'],
    });
  }
  return filled;
}

function buildHashtags(seoKeywords: string[]) {
  const unique = Array.from(
    new Set(
      seoKeywords
        .map((kw) => kw.replace(/^#+/, '').trim())
        .filter(Boolean),
    ),
  );
  return unique.slice(0, 9);
}

function renderHighlightedLine(line: string, keywords: string[]) {
  if (!line) return line;
  const usableKeywords = keywords.filter((keyword) => keyword.trim().length > 0);
  if (usableKeywords.length === 0) return line;

  const regex = new RegExp(`(${usableKeywords.map((keyword) => escapeRegExp(keyword)).join('|')})`, 'g');
  const parts = line.split(regex);

  return parts.map((part, idx) =>
    usableKeywords.includes(part) ? (
      <span key={`kw-${idx}`} style={{ backgroundColor: '#FFFF00' }}>
        {part}
      </span>
    ) : (
      <React.Fragment key={`txt-${idx}`}>{part}</React.Fragment>
    ),
  );
}

function renderHighlightedBody(body: string, keywords: string[]) {
  const lines = body.split('\n');
  return lines.map((line, idx) => (
    <React.Fragment key={`line-${idx}`}>
      {renderHighlightedLine(line, keywords)}
      {idx < lines.length - 1 && <br />}
    </React.Fragment>
  ));
}

function wrapCanvasTextByWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const characters = Array.from(text.trim());
  const lines: string[] = [];
  let current = '';

  for (const ch of characters) {
    const trial = `${current}${ch}`;
    if (current && ctx.measureText(trial).width > maxWidth) {
      lines.push(current);
      current = ch;
    } else {
      current = trial;
    }
  }

  if (current) lines.push(current);
  if (lines.length <= 3) return lines;
  return [lines[0], lines[1], `${lines.slice(2).join('').slice(0, 22)}…`];
}

function buildQuoteCardDataUrl(quote: string, philosopher: string) {
  if (typeof document === 'undefined') return '';

  const pastelPalette = [
    '#F9EAEA',
    '#EAF3F9',
    '#EEF8EE',
    '#FFF4E6',
    '#F3EDFF',
    '#EAF7F5',
    '#FFF0F5',
    '#F4F4E8',
  ];
  const backgroundColor = pastelPalette[Math.floor(Math.random() * pastelPalette.length)];

  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 420;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const safeQuote = quote.trim() || '오늘의 순간을 기록하는 마음으로 하루를 담아봅니다.';
  ctx.fillStyle = '#555555';
  ctx.font = '600 54px "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const quoteLines = wrapCanvasTextByWidth(ctx, safeQuote, canvas.width * 0.82);
  const lineHeight = 66;
  const quoteStartY = 165 - ((quoteLines.length - 1) * lineHeight) / 2;
  quoteLines.forEach((line, idx) => {
    ctx.fillText(line, canvas.width / 2, quoteStartY + idx * lineHeight);
  });

  const safePhilosopher = philosopher.trim() || '작자 미상';
  ctx.fillStyle = '#4B4B4B';
  ctx.font = '500 42px "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  ctx.fillText(`- ${safePhilosopher} -`, canvas.width / 2, quoteStartY + quoteLines.length * lineHeight + 46);

  return canvas.toDataURL('image/png');
}

const IMAGE_MAX_SIZE = 1280;
const IMAGE_JPEG_QUALITY = 0.82;

function getResizedDimensions(width: number, height: number, maxSize = IMAGE_MAX_SIZE) {
  let nextWidth = width;
  let nextHeight = height;

  if (nextWidth > nextHeight) {
    if (nextWidth > maxSize) {
      nextHeight *= maxSize / nextWidth;
      nextWidth = maxSize;
    }
  } else if (nextHeight > maxSize) {
    nextWidth *= maxSize / nextHeight;
    nextHeight = maxSize;
  }

  return {
    width: Math.max(1, Math.round(nextWidth)),
    height: Math.max(1, Math.round(nextHeight)),
  };
}

function drawOptimizedJpeg(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, fallback = '') {
  const canvas = document.createElement('canvas');
  const { width, height } = getResizedDimensions(sourceWidth, sourceHeight);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return fallback;

  ctx.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
}

function loadImageElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지 디코딩 실패'));
    img.src = src;
  });
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        reject(new Error('이미지 데이터를 읽지 못했습니다.'));
        return;
      }
      resolve(dataUrl);
    };
    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.readAsDataURL(file);
  });
}

async function readFileAsDataUrlFromArrayBuffer(file: File) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  const mimeType = file.type && file.type.trim() ? file.type : 'application/octet-stream';
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function readFileAsDataUrlSafe(file: File) {
  try {
    return await readFileAsDataUrl(file);
  } catch {
    return await readFileAsDataUrlFromArrayBuffer(file);
  }
}

function optimizeImageDataUrl(dataUrl: string) {
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        resolve(drawOptimizedJpeg(img, img.width, img.height, dataUrl));
      } catch {
        // 캔버스 변환 실패 시 원본 유지
        resolve(dataUrl);
      }
    };
    img.onerror = () => {
      // 일부 포맷 디코딩 실패 시 원본 유지
      resolve(dataUrl);
    };
    img.src = dataUrl;
  });
}

async function optimizeImageFromObjectUrl(file: File) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(objectUrl);
    return drawOptimizedJpeg(img, img.naturalWidth || img.width, img.naturalHeight || img.height, '');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function processUploadFile(file: File) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const optimizedByObjectUrl = await optimizeImageFromObjectUrl(file);
      if (optimizedByObjectUrl) return optimizedByObjectUrl;
    } catch {
      // object URL 디코딩 실패 시 data URL 경로로 폴백
    }

    try {
      const original = await readFileAsDataUrlSafe(file);
      const optimized = await optimizeImageDataUrl(original);
      if (optimized) return optimized;
    } catch {
      // 읽기 실패 시 다음 시도로 재시도
    }
  }

  return '';
}

export default function App() {
  const [images, setImages] = useState<string[]>([]);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [otherLocation, setOtherLocation] = useState('');
  const [isOtherLocation, setIsOtherLocation] = useState(false);
  const [selectedPurposes, setSelectedPurposes] = useState<string[]>([]);
  const [otherPurpose, setOtherPurpose] = useState('');
  const [isOtherPurpose, setIsOtherPurpose] = useState(false);
  const [peopleInput, setPeopleInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('AI가 글을 작성 중입니다...');
  const [generatedPost, setGeneratedPost] = useState<BlogPost | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ success: boolean; url: string; editorUrl?: string } | null>(null);
  const [isStep1Confirmed, setIsStep1Confirmed] = useState(false);

  const onDrop = useCallback(async (acceptedFiles: File[], fileRejections: FileRejection[]) => {
    const incomingCount = acceptedFiles.length + fileRejections.length;
    if (images.length + incomingCount > MAX_IMAGES || fileRejections.length > 0) {
      alert('이미지는 10개 까지 가능합니다.');
    }

    const remainingSlots = MAX_IMAGES - images.length;
    const filesToProcess = acceptedFiles.slice(0, remainingSlots);

    if (filesToProcess.length === 0) return;

    const newImages: string[] = [];
    for (const file of filesToProcess) {
      let processed = await processUploadFile(file);
      if (!processed) {
        processed = await processUploadFile(file);
      }
      if (processed) newImages.push(processed);
    }

    const failedCount = filesToProcess.length - newImages.length;
    if (failedCount > 0) {
      alert(`이미지 ${failedCount}장을 처리하지 못했습니다. 다른 파일로 다시 시도해주세요.`);
    }

    if (newImages.length > 0) {
      setImages(prev => [...prev, ...newImages].slice(0, MAX_IMAGES));
      setIsStep1Confirmed(false);
    }
  }, [images.length]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    multiple: true,
    disabled: images.length >= MAX_IMAGES
  } as any);

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
    setIsStep1Confirmed(false);
  };

  const toggleLocation = (loc: string) => {
    setSelectedLocations(prev => 
      prev.includes(loc) 
        ? prev.filter(l => l !== loc) 
        : [...prev, loc]
    );
  };

  const togglePurpose = (purpose: string) => {
    setSelectedPurposes(prev => 
      prev.includes(purpose) 
        ? prev.filter(p => p !== purpose) 
        : [...prev, purpose]
    );
  };

  const handleStep1Confirm = () => {
    if (!validateImages(images)) return;
    setIsStep1Confirmed(true);
  };

  const publishGeneratedPost = async (post: BlogPost) => {
    const structuredSections = buildStructuredSections(post.sections, images.length);
    const hashtags = buildHashtags(post.seoKeywords);
    const quoteSection = parseQuoteSection(post.quote || '');
    const contentLines: string[] = [];

    if (quoteSection.quote) {
      contentLines.push(`"${quoteSection.quote}"\n- ${quoteSection.philosopher} -`);
    }

    structuredSections.forEach((section) => {
      contentLines.push(`■ ${section.subtitle} ■\n${section.body}`);
    });

    if (hashtags.length > 0) {
      contentLines.push(hashtags.map((tag) => `#${tag}`).join(' '));
    }

    const response = await axios.post('/api/publish', {
      title: post.title,
      content: contentLines.join('\n\n'),
      images,
      quote: `"${quoteSection.quote}"\n- ${quoteSection.philosopher} -`,
      quoteText: quoteSection.quote,
      quoteAuthor: quoteSection.philosopher,
      sections: structuredSections,
      hashtags,
      blogType: 'Naver',
    });

    setPublishResult(response.data);
    return response.data as { success?: boolean; url?: string; editorUrl?: string };
  };

  const handleGenerate = async () => {
    if (!validateImages(images)) return;
    if (!isStep1Confirmed) {
      alert('Step 1 확인 버튼을 먼저 눌러주세요.');
      return;
    }

    const finalLocations = isOtherLocation 
      ? [...selectedLocations, otherLocation].filter(l => l !== '')
      : selectedLocations;
    const finalPurposes = isOtherPurpose 
      ? [...selectedPurposes, otherPurpose].filter(p => p !== '')
      : selectedPurposes;

    console.log('Generating with:', {
      locations: finalLocations,
      purposes: finalPurposes,
      imageCount: images.length
    });

    setIsGenerating(true);
    setIsPublishing(false);
    setGeneratedPost(null);
    setPublishResult(null);

    const postInfo = calculatePostInfo(images.length);
    const finalLength = postInfo.totalChars;
    const finalSections = postInfo.sectionCount;
    const safeLocations = finalLocations.length > 0 ? finalLocations : ['일상'];
    const safePurposes = finalPurposes.length > 0 ? finalPurposes : ['네이버 자동 포스팅'];

    // Set a timeout to show different messages
    const loadingMessages = [
      '이미지를 분석하고 있습니다...',
      `총 섹션 ${finalSections}개 기준으로 작성 중입니다...`,
      `총 글자수 약 ${finalLength}자 기준으로 본문을 구성 중입니다...`,
      '네이버 블로그 자동 포스팅을 준비하고 있습니다...'
    ];
    let messageIdx = 0;
    const interval = setInterval(() => {
      messageIdx = (messageIdx + 1) % loadingMessages.length;
      setLoadingMessage(loadingMessages[messageIdx]);
    }, 3000);
    setLoadingMessage(loadingMessages[0]);

    try {
      const input: UserInput = {
        location: safeLocations,
        purposes: safePurposes,
        people: peopleInput,
        length: finalLength,
        sections: finalSections,
        images
      };
      const post = await generateBlogPost(input);
      setIsPublishing(true);
      const publishData = await publishGeneratedPost(post);
      setIsPublishing(false);

      const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isMobileDevice) {
        const fallbackEditorUrl = 'https://blog.naver.com/checknpick/postwrite';
        const targetEditorUrl =
          typeof publishData?.editorUrl === 'string' && publishData.editorUrl.trim().length > 0
            ? publishData.editorUrl
            : fallbackEditorUrl;
        window.location.href = targetEditorUrl;
        return;
      }

      setGeneratedPost(post);

      // Scroll to result
      setTimeout(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }, 100);
    } catch (error: any) {
      console.error('Generation or publishing failed:', error);
      const serverMessage = error?.response?.data?.message;
      alert(serverMessage || error?.message || '자동 포스팅 중 오류가 발생했습니다.');
      setIsPublishing(false);
    } finally {
      setIsGenerating(false);
      clearInterval(interval);
    }
  };

  const handlePublish = async () => {
    if (!generatedPost) return;
    if (!validateImages(images)) return;

    setIsPublishing(true);
    try {
      await publishGeneratedPost(generatedPost);
    } catch (error: any) {
      console.error('Publishing failed:', error);
      const serverMessage = error?.response?.data?.message;
      alert(serverMessage || '발행 중 오류가 발생했습니다.');
    } finally {
      setIsPublishing(false);
    }
  };

  const postInfo = calculatePostInfo(images.length);
  const quoteSection = generatedPost ? parseQuoteSection(generatedPost.quote || '') : null;
  const quoteCardImage = useMemo(() => {
    if (!quoteSection) return '';
    return buildQuoteCardDataUrl(quoteSection.quote || '', quoteSection.philosopher || '작자 미상');
  }, [quoteSection?.quote, quoteSection?.philosopher]);
  const hasUploadedImages = images.length > 0;

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans pb-20">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-100 px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">AI Blog Writer</h1>
          </div>
          {generatedPost && (
            <button
              onClick={() => setGeneratedPost(null)}
              className="text-sm font-medium text-gray-500 hover:text-black transition-colors"
            >
              새로 만들기
            </button>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8 space-y-10">
        {!generatedPost ? (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-10"
          >
            {/* Step 1: Photos */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-gray-500">
                  <Target className="w-5 h-5" />
                  <h2 className="text-sm font-semibold uppercase tracking-wider">STEP 1. 이미지 분석 ({images.length}/{MAX_IMAGES})</h2>
                </div>
                {images.length > 0 && (
                  <button 
                    onClick={() => {
                      setImages([]);
                      setIsStep1Confirmed(false);
                    }}
                    className="text-xs font-bold text-red-500 hover:text-red-600 transition-colors"
                  >
                    전체 삭제
                  </button>
                )}
              </div>
              
              <div className={cn(hasUploadedImages ? "grid grid-cols-3 gap-3" : "flex justify-center")}>
                {images.map((img, idx) => (
                  <div key={idx} className="relative aspect-square rounded-xl overflow-hidden group shadow-sm border border-gray-100">
                    <img src={img} alt={`upload-${idx}`} className="w-full h-full object-cover" />
                    <button 
                      onClick={() => removeImage(idx)}
                      className="absolute top-1.5 right-1.5 p-1 bg-white/90 text-black rounded-full shadow-md hover:bg-white transition-all"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {images.length < MAX_IMAGES && (
                  <div 
                    {...getRootProps()} 
                    className={cn(
                      "aspect-square rounded-xl border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition-all",
                      hasUploadedImages ? "" : "w-full max-w-[220px]",
                      isDragActive ? "border-black bg-gray-50" : "border-gray-200 hover:border-gray-300 bg-white"
                    )}
                  >
                    <input {...getInputProps()} />
                    <div className="w-10 h-10 bg-gray-50 rounded-full flex items-center justify-center mb-2 group-hover:bg-gray-100 transition-colors">
                      <Plus className="w-6 h-6 text-gray-400" />
                    </div>
                    <span className="block w-full text-center text-xs text-gray-400 font-bold">사진 추가</span>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4 space-y-3 text-center">
                <p className="text-sm font-semibold text-gray-800">총 섹션: {postInfo.sectionCount}개</p>
                <p className="text-sm font-semibold text-gray-800">총 글자수: 약 {postInfo.totalChars}자</p>
                <button
                  onClick={handleStep1Confirm}
                  className={cn(
                    "w-full py-3 rounded-xl font-bold transition-all",
                    isStep1Confirmed
                      ? "bg-[#03C75A] text-white"
                      : "bg-black text-white hover:bg-gray-900"
                  )}
                >
                  {isStep1Confirmed ? '확인 완료' : '확인'}
                </button>
              </div>
            </section>

            {/* Step 2: Location */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-gray-500">
                <Target className="w-5 h-5" />
                <h2 className="text-sm font-semibold uppercase tracking-wider">Step 2. 어디인가요? (복수선택 가능)</h2>
              </div>
              
              <div className="flex flex-wrap gap-2">
                {LOCATIONS.map(loc => (
                  <button
                    key={loc}
                    onClick={() => toggleLocation(loc)}
                    className={cn(
                      "px-5 py-2.5 rounded-full text-sm font-medium transition-all border",
                      selectedLocations.includes(loc)
                        ? "bg-black text-white border-black shadow-lg shadow-black/10"
                        : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
                    )}
                  >
                    {loc}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsOtherLocation(!isOtherLocation)}
                  className={cn(
                    "px-5 py-2.5 rounded-full text-sm font-bold transition-all border whitespace-nowrap",
                    isOtherLocation
                      ? "bg-[#FF6321] text-white border-[#FF6321] shadow-lg shadow-[#FF6321]/20"
                      : "bg-white text-[#FF6321] border-[#FF6321] hover:bg-[#FF6321]/5"
                  )}
                >
                  기타 (직접 입력)
                </button>
                <AnimatePresence>
                  {isOtherLocation && (
                    <motion.div
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      className="flex-1 flex items-center gap-2"
                    >
                      <input
                        type="text"
                        value={otherLocation}
                        onChange={(e) => setOtherLocation(e.target.value)}
                        placeholder="장소를 입력해주세요"
                        className="w-full px-4 py-2.5 bg-white border-2 border-[#FF6321] rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-[#FF6321]/20 transition-all"
                      />
                      <div className="w-8 h-8 bg-[#FF6321] rounded-full flex items-center justify-center shrink-0 shadow-lg shadow-[#FF6321]/20">
                        <CheckCircle2 className="w-5 h-5 text-white" />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </section>

            {/* Step 3: Purpose */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-gray-500">
                <Target className="w-5 h-5" />
                <h2 className="text-sm font-semibold uppercase tracking-wider">Step 3. 어떤 이유로 이 사진 찰칵? (복수선택 가능)</h2>
              </div>
              
              <div className="flex flex-wrap gap-2">
                {PURPOSES.map(purpose => (
                  <button
                    key={purpose}
                    onClick={() => togglePurpose(purpose)}
                    className={cn(
                      "px-5 py-2.5 rounded-full text-sm font-medium transition-all border",
                      selectedPurposes.includes(purpose)
                        ? "bg-black text-white border-black shadow-lg shadow-black/10"
                        : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
                    )}
                  >
                    {purpose}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsOtherPurpose(!isOtherPurpose)}
                  className={cn(
                    "px-5 py-2.5 rounded-full text-sm font-bold transition-all border whitespace-nowrap",
                    isOtherPurpose
                      ? "bg-[#FF6321] text-white border-[#FF6321] shadow-lg shadow-[#FF6321]/20"
                      : "bg-white text-[#FF6321] border-[#FF6321] hover:bg-[#FF6321]/5"
                  )}
                >
                  기타 (직접 입력)
                </button>
                <AnimatePresence>
                  {isOtherPurpose && (
                    <motion.div
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      className="flex-1 flex items-center gap-2"
                    >
                      <input
                        type="text"
                        value={otherPurpose}
                        onChange={(e) => setOtherPurpose(e.target.value)}
                        placeholder="이유를 입력해주세요"
                        className="w-full px-4 py-2.5 bg-white border-2 border-[#FF6321] rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-[#FF6321]/20 transition-all"
                      />
                      <div className="w-8 h-8 bg-[#FF6321] rounded-full flex items-center justify-center shrink-0 shadow-lg shadow-[#FF6321]/20">
                        <CheckCircle2 className="w-5 h-5 text-white" />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </section>

            {/* Step 4: People */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-gray-500">
                <Target className="w-5 h-5" />
                <h2 className="text-sm font-semibold uppercase tracking-wider">STEP 4. 사진 속에 사람이 있다면 누구,누구? (아래에 자유롭게 입력!)</h2>
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={peopleInput}
                  onChange={(e) => setPeopleInput(e.target.value)}
                  placeholder="예: 친구와 나, 가족들, 남자친구 등"
                  className="w-full px-6 py-4 bg-white border-2 border-gray-100 rounded-2xl text-base focus:outline-none focus:border-black transition-all shadow-sm"
                />
              </div>
            </section>

            {/* Generate Button */}
            <button
              onClick={handleGenerate}
              disabled={isGenerating || !isStep1Confirmed}
              className="w-full py-4 bg-black text-white rounded-2xl font-bold text-lg flex items-center justify-center gap-2 hover:bg-gray-900 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-xl shadow-black/10"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {loadingMessage}
                </>
              ) : (
                <>
                  <Send className="w-5 h-5" />
                  네이버 블로그 자동 포스팅 실핼 !
                </>
              )}
            </button>
          </motion.div>
        ) : (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="space-y-8"
          >
            {/* Generated Content View */}
            <article
              className="bg-white rounded-3xl p-8 shadow-sm border border-gray-100 space-y-8"
              style={{ wordBreak: 'keep-all', overflowWrap: 'normal', wordWrap: 'normal' }}
            >
              <header className="space-y-6">
                <div className="flex flex-wrap gap-2">
                  {generatedPost.seoKeywords.map(kw => (
                    <span key={kw} className="px-2 py-1 bg-gray-100 text-[10px] font-bold text-gray-500 rounded-md uppercase tracking-wider">#{kw}</span>
                  ))}
                </div>
                <div className="flex items-center justify-between">
                  <h1 className="text-3xl font-black leading-tight tracking-tight flex-1 text-center" style={{ wordBreak: 'keep-all', overflowWrap: 'normal', wordWrap: 'normal' }}>
                    {generatedPost.title}
                  </h1>
                  <div className="ml-4 px-3 py-1 bg-black/5 rounded-full shrink-0">
                    <span className="text-[10px] font-bold text-gray-500 uppercase">
                      약 {generatedPost.sections.join('').length}자
                    </span>
                  </div>
                </div>
                <div className="rounded-2xl overflow-hidden border border-gray-200 bg-gray-100">
                  {quoteCardImage ? (
                    <img
                      src={quoteCardImage}
                      alt="철학자 명언 이미지"
                      className="w-full h-auto block"
                    />
                  ) : (
                    <p className="py-8 text-center text-gray-600 whitespace-pre-wrap">
                      "{quoteSection?.quote || ''}"{'\n'}- {quoteSection?.philosopher || '작자 미상'} -
                    </p>
                  )}
                </div>
              </header>

              <div className="space-y-12">
                {buildStructuredSections(generatedPost.sections, images.length).map((section, idx) => (
                  <section key={idx} className="space-y-4">
                    {images[idx] && (
                      <div className="rounded-2xl overflow-hidden shadow-lg aspect-[4/3]">
                        <img
                          src={images[idx]}
                          alt={`Blog image ${idx + 1}`}
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      </div>
                    )}
                    <h3 className="text-center font-bold text-[133%]" style={{ wordBreak: 'keep-all', overflowWrap: 'normal', wordWrap: 'normal' }}>
                      ■ {section.subtitle} ■
                    </h3>
                    <p className="text-gray-700 leading-relaxed text-lg whitespace-pre-wrap text-center" style={{ wordBreak: 'keep-all', overflowWrap: 'normal', wordWrap: 'normal' }}>
                      {renderHighlightedBody(section.body, section.keywords)}
                    </p>
                  </section>
                ))}
              </div>
            </article>

            {/* Publishing Controls */}
            <div className="sticky bottom-6 flex flex-col gap-4">
              {publishResult ? (
                <motion.div 
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  className="bg-green-50 border border-green-100 p-4 rounded-2xl flex items-center justify-between shadow-lg"
                >
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="w-6 h-6 text-green-500" />
                    <div>
                      <p className="text-sm font-bold text-green-800">발행 완료!</p>
                      <p className="text-xs text-green-600">블로그에 성공적으로 등록되었습니다.</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <a 
                      href={publishResult.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm font-bold text-green-700 hover:underline"
                    >
                      보러가기 <ExternalLink className="w-4 h-4" />
                    </a>
                    <button
                      onClick={() => {
                        setGeneratedPost(null);
                        setPublishResult(null);
                      }}
                      className="px-4 py-2 bg-white border border-green-200 text-green-700 rounded-xl text-sm font-bold hover:bg-green-50 transition-all"
                    >
                      새 글 쓰기
                    </button>
                  </div>
                </motion.div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setGeneratedPost(null)}
                    className="py-4 bg-white text-black border-2 border-black rounded-2xl font-bold text-lg hover:bg-gray-50 transition-all shadow-xl shadow-black/5"
                  >
                    포스팅 글 새로 생성하기
                  </button>
                  <button
                    onClick={handlePublish}
                    disabled={isPublishing}
                    className="py-4 bg-[#03C75A] text-white rounded-2xl font-bold text-lg flex items-center justify-center gap-2 hover:opacity-90 transition-all disabled:opacity-50 shadow-xl shadow-[#03C75A]/20"
                  >
                    {isPublishing ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        발행 중...
                      </>
                    ) : (
                      <>
                        네이버 블로그 발행
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </main>
    </div>
  );
}
