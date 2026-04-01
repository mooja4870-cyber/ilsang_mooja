export interface BlogPost {
  title: string;
  quote: string;
  sections: string[];
  seoKeywords: string[];
}

export interface UserInput {
  location: string[];
  purposes: string[];
  people: string;
  length: number;
  sections: number;
  images: string[]; // base64 strings
}

export const LOCATIONS = ["카페", "공원", "영화관", "쇼핑몰", "전시회장", "일식가", "중식가", "한식가"];
export const PURPOSES = ["데이트", "미팅", "산책", "카페 투어", "공부", "쇼핑", "운동", "여행"];
export const LENGTH_OPTIONS = [
  { label: "사진 수 비례", value: 0, sections: 0 },
  { label: "500자", value: 500, sections: 2 },
  { label: "1,000자", value: 1000, sections: 4 },
  { label: "1,500자", value: 1500, sections: 6 },
  { label: "2,000자", value: 2000, sections: 8 },
];
