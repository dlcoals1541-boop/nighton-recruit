import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'NIGHTON | 배차의 새로운 기준',description:'NIGHTON 실시간 콜 배차 및 지급 관리',manifest:'/manifest.webmanifest',icons:{icon:'/favicon.svg'},appleWebApp:{capable:true,title:'NIGHTON',statusBarStyle:'black-translucent'}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="ko"><body>{children}</body></html>}
