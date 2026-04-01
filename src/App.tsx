import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
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
  Quote,
  ExternalLink,
  Sparkles
} from 'lucide-react';
import { cn } from './lib/utils';
import { LOCATIONS, PURPOSES, LENGTH_OPTIONS, UserInput, BlogPost } from './types';
import { generateBlogPost } from './services/geminiService';
import axios from 'axios';

export default function App() {
  const [images, setImages] = useState<string[]>([]);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [otherLocation, setOtherLocation] = useState('');
  const [isOtherLocation, setIsOtherLocation] = useState(false);
  const [selectedPurposes, setSelectedPurposes] = useState<string[]>([]);
  const [otherPurpose, setOtherPurpose] = useState('');
  const [isOtherPurpose, setIsOtherPurpose] = useState(false);
  const [peopleInput, setPeopleInput] = useState('');
  const [lengthOption, setLengthOption] = useState(LENGTH_OPTIONS[0]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('AI가 글을 작성 중입니다...');
  const [generatedPost, setGeneratedPost] = useState<BlogPost | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ success: boolean; url: string } | null>(null);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const remainingSlots = 15 - images.length;
    const filesToProcess = acceptedFiles.slice(0, remainingSlots);

    if (filesToProcess.length === 0) return;

    Promise.all(
      filesToProcess.map(file => {
        return new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const img = new Image();
            img.onload = () => {
              const canvas = document.createElement('canvas');
              const MAX_SIZE = 1024;
              let width = img.width;
              let height = img.height;

              if (width > height) {
                if (width > MAX_SIZE) {
                  height *= MAX_SIZE / width;
                  width = MAX_SIZE;
                }
              } else {
                if (height > MAX_SIZE) {
                  width *= MAX_SIZE / height;
                  height = MAX_SIZE;
                }
              }

              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d');
              ctx?.drawImage(img, 0, 0, width, height);
              resolve(canvas.toDataURL('image/jpeg', 0.8));
            };
            img.src = reader.result as string;
          };
          reader.readAsDataURL(file);
        });
      })
    ).then(newImages => {
      setImages(prev => [...prev, ...newImages].slice(0, 15));
    });
  }, [images.length]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    maxFiles: 15,
    multiple: true,
    disabled: images.length >= 15
  } as any);

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
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

  const handleGenerate = async () => {
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

    if (images.length === 0) {
      alert('최소 1장의 사진을 첨부해주세요!');
      return;
    }

    if (finalLocations.length === 0) {
      alert('장소를 최소 1개 선택하거나 입력해주세요!');
      return;
    }

    if (finalPurposes.length === 0) {
      alert('포스팅 목적을 최소 1개 선택해주세요!');
      return;
    }

    setIsGenerating(true);
    setGeneratedPost(null);
    setPublishResult(null);

    // Smart logic: Calculate length and sections based on images if Smart option is selected
    let finalLength = lengthOption.value;
    let finalSections = lengthOption.sections;

    if (lengthOption.value === 0) {
      // Smart calculation: Cap at 2000 characters
      // Aim for roughly 2-3 images per section if there are many images
      finalSections = Math.max(2, Math.min(8, Math.ceil(images.length / 2)));
      finalLength = Math.min(2000, images.length * 200);
      if (finalLength < 500) finalLength = 500;
    }

    // Set a timeout to show different messages
    const loadingMessages = [
      '이미지를 분석하고 있습니다...',
      `SEO 최적화된 제목을 짓고 있습니다... (목표: 약 ${finalLength}자)`,
      '블로그 내용을 작성 중입니다...',
      '거의 다 되었습니다!'
    ];
    let messageIdx = 0;
    const interval = setInterval(() => {
      messageIdx = (messageIdx + 1) % loadingMessages.length;
      setLoadingMessage(loadingMessages[messageIdx]);
    }, 3000);
    setLoadingMessage(loadingMessages[0]);

    try {
      const input: UserInput = {
        location: finalLocations,
        purposes: finalPurposes,
        people: peopleInput,
        length: finalLength,
        sections: finalSections,
        images
      };
      const post = await generateBlogPost(input);
      setGeneratedPost(post);
      // Scroll to result
      setTimeout(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }, 100);
    } catch (error: any) {
      console.error('Generation failed:', error);
      alert(error.message || '포스팅 생성 중 오류가 발생했습니다.');
    } finally {
      setIsGenerating(false);
      clearInterval(interval);
    }
  };

  const handlePublish = async () => {
    if (!generatedPost) return;

    setIsPublishing(true);
    try {
      const response = await axios.post('/api/publish', {
        title: generatedPost.title,
        content: generatedPost.sections.join('\n\n'),
        blogType: 'Naver' // Default for demo
      });
      setPublishResult(response.data);
    } catch (error) {
      console.error('Publishing failed:', error);
      alert('발행 중 오류가 발생했습니다.');
    } finally {
      setIsPublishing(false);
    }
  };

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
                  <h2 className="text-sm font-semibold uppercase tracking-wider">STEP 1. 사진 첨부 ({images.length}/15)</h2>
                </div>
                {images.length > 0 && (
                  <button 
                    onClick={() => setImages([])}
                    className="text-xs font-bold text-red-500 hover:text-red-600 transition-colors"
                  >
                    전체 삭제
                  </button>
                )}
              </div>
              
              <div className="grid grid-cols-3 gap-3">
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
                {images.length < 15 && (
                  <div 
                    {...getRootProps()} 
                    className={cn(
                      "aspect-square rounded-xl border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition-all",
                      isDragActive ? "border-black bg-gray-50" : "border-gray-200 hover:border-gray-300 bg-white"
                    )}
                  >
                    <input {...getInputProps()} />
                    <div className="w-10 h-10 bg-gray-50 rounded-full flex items-center justify-center mb-2 group-hover:bg-gray-100 transition-colors">
                      <Plus className="w-6 h-6 text-gray-400" />
                    </div>
                    <span className="text-xs text-gray-400 font-bold">사진 추가</span>
                  </div>
                )}
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

            {/* Step 5: Length */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-gray-500">
                <Target className="w-5 h-5" />
                <h2 className="text-sm font-semibold uppercase tracking-wider">Step 5. 분량 설정</h2>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {LENGTH_OPTIONS.map(opt => {
                  const isSmart = opt.value === 0;
                  let calculatedSections = opt.sections;
                  let calculatedLength = opt.value;
                  
                  if (isSmart) {
                    calculatedSections = Math.max(2, Math.min(8, Math.ceil(images.length / 2)));
                    calculatedLength = Math.min(2000, images.length * 200);
                    if (calculatedLength < 500) calculatedLength = 500;
                  }
                  
                  return (
                    <button
                      key={opt.label}
                      onClick={() => setLengthOption(opt)}
                      className={cn(
                        "p-4 rounded-xl border text-center transition-all",
                        lengthOption.label === opt.label
                          ? "border-black bg-black text-white shadow-lg shadow-black/10"
                          : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                      )}
                    >
                      <div className="text-sm font-bold">{opt.label}</div>
                      <div className="text-[10px] opacity-60 uppercase tracking-tighter mt-1">
                        {isSmart ? `약 ${calculatedLength}자 / ${calculatedSections} Sections` : `${opt.sections} Sections`}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Generate Button */}
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
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
                  블로그 포스팅 생성하기
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
            <article className="bg-white rounded-3xl p-8 shadow-sm border border-gray-100 space-y-8">
              <header className="space-y-6">
                <div className="flex flex-wrap gap-2">
                  {generatedPost.seoKeywords.map(kw => (
                    <span key={kw} className="px-2 py-1 bg-gray-100 text-[10px] font-bold text-gray-500 rounded-md uppercase tracking-wider">#{kw}</span>
                  ))}
                </div>
                <div className="flex items-center justify-between">
                  <h1 className="text-3xl font-black leading-tight tracking-tight flex-1">{generatedPost.title}</h1>
                  <div className="ml-4 px-3 py-1 bg-black/5 rounded-full shrink-0">
                    <span className="text-[10px] font-bold text-gray-500 uppercase">
                      약 {generatedPost.sections.join('').length}자
                    </span>
                  </div>
                </div>
                <div className="relative py-8 px-10 bg-gray-50 rounded-2xl">
                  <Quote className="absolute top-4 left-4 w-6 h-6 text-gray-200" />
                  <p className="text-lg font-serif italic text-center text-gray-700 leading-relaxed">
                    {generatedPost.quote}
                  </p>
                </div>
              </header>

              <div className="space-y-12">
                {generatedPost.sections.map((section, idx) => {
                  // Split the section by [IMAGE_X] tags
                  const parts = section.split(/(\[IMAGE_\d+\])/);
                  // Group consecutive image tags to render them in a grid
                  const renderedParts: React.ReactNode[] = [];
                  let currentImageGroup: number[] = [];

                  parts.forEach((part, i) => {
                    const match = part.match(/\[IMAGE_(\d+)\]/);
                    if (match) {
                      const imgIdx = parseInt(match[1]) - 1;
                      if (images[imgIdx]) {
                        currentImageGroup.push(imgIdx);
                      }
                    } else {
                      // If we have a pending image group, render it
                      if (currentImageGroup.length > 0) {
                        const group = [...currentImageGroup];
                        renderedParts.push(
                          <div key={`group-${i}`} className={cn(
                            "my-8 grid gap-4",
                            group.length === 1 ? "grid-cols-1" : 
                            group.length === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3"
                          )}>
                            {group.map((idx) => (
                              <div key={idx} className="rounded-2xl overflow-hidden shadow-lg aspect-[4/3]">
                                <img 
                                  src={images[idx]} 
                                  alt={`Blog image ${idx + 1}`} 
                                  className="w-full h-full object-cover"
                                  referrerPolicy="no-referrer"
                                />
                              </div>
                            ))}
                          </div>
                        );
                        currentImageGroup = [];
                      }
                      
                      if (part.trim()) {
                        renderedParts.push(
                          <p key={i} className="text-gray-700 leading-relaxed text-lg whitespace-pre-wrap mb-6">
                            {part}
                          </p>
                        );
                      }
                    }
                  });

                  // Final check for trailing images
                  if (currentImageGroup.length > 0) {
                    const group = [...currentImageGroup];
                    renderedParts.push(
                      <div key="group-final" className={cn(
                        "my-8 grid gap-4",
                        group.length === 1 ? "grid-cols-1" : 
                        group.length === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3"
                      )}>
                        {group.map((idx) => (
                          <div key={idx} className="rounded-2xl overflow-hidden shadow-lg aspect-[4/3]">
                            <img 
                              src={images[idx]} 
                              alt={`Blog image ${idx + 1}`} 
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                            />
                          </div>
                        ))}
                      </div>
                    );
                  }

                  return (
                    <section key={idx} className="space-y-2">
                      {renderedParts}
                    </section>
                  );
                })}
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
