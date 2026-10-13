import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { randomBytes } from 'crypto';

type Person={id:string;username:string;isHost:boolean};
type Message={id:string;username:string;text:string;timestamp:number;system?:boolean};
type Playback={url:string;kind:'youtube'|'direct';currentTime:number;isPlaying:boolean;updatedAt:number};
type Room={id:string;hostId:string;participants:Map<string,Person>;messages:Message[];playback:Playback|null};
const app=express(); app.use(cors({origin:true})); app.use(express.json());
app.get('/health',(_req,res)=>res.json({ok:true,service:'watchparty'}));
const server=createServer(app); const io=new Server(server,{cors:{origin:true,methods:['GET','POST']}});
const rooms=new Map<string,Room>(); const socketRooms=new Map<string,string>();
const snapshot=(r:Room)=>({id:r.id,hostId:r.hostId,participants:[...r.participants.values()],messages:r.messages.slice(-60),playback:r.playback});
const cleanName=(x:unknown)=>String(x??'').trim().replace(/\s+/g,' ').slice(0,24)||'Guest';
function system(r:Room,text:string){r.messages.push({id:randomBytes(8).toString('hex'),username:'WatchParty',text,timestamp:Date.now(),system:true});r.messages=r.messages.slice(-100)}
function emitRoom(r:Room){io.to(r.id).emit('room:update',snapshot(r))}
function leave(s:Socket){const id=socketRooms.get(s.id);if(!id)return;const r=rooms.get(id);s.leave(id);socketRooms.delete(s.id);if(!r)return;const p=r.participants.get(s.id);if(p){r.participants.delete(s.id);system(r,`${p.username} left the room`)}if(!r.participants.size){rooms.delete(id);return}if(r.hostId===s.id){const next=r.participants.values().next().value as Person|undefined;if(next){r.hostId=next.id;next.isHost=true;system(r,`${next.username} is now the host`)}}emitRoom(r)}
function member(s:Socket){const id=socketRooms.get(s.id);const r=id?rooms.get(id):undefined;return r&&r.participants.has(s.id)?r:null}
function fail(s:Socket,msg:string){s.emit('app:error',msg)}
io.on('connection',s=>{
 s.emit('server:ready',{ok:true});
 s.on('room:create',(p:{username?:string},ack?:(x:unknown)=>void)=>{leave(s);let id='';do{id=randomBytes(4).toString('hex').slice(0,6).toUpperCase()}while(rooms.has(id));const name=cleanName(p?.username);const person={id:s.id,username:name,isHost:true};const r:Room={id,hostId:s.id,participants:new Map([[s.id,person]]),messages:[],playback:null};system(r,`${name} created the room`);rooms.set(id,r);s.join(id);socketRooms.set(s.id,id);ack?.({ok:true,roomId:id,room:snapshot(r)});emitRoom(r)});
 s.on('room:join',(p:{roomId?:string;username?:string},ack?:(x:unknown)=>void)=>{leave(s);const id=String(p?.roomId??'').trim().toUpperCase();const r=rooms.get(id);if(!/^[A-Z0-9]{6}$/.test(id)||!r){ack?.({ok:false,message:'Room not found. Check the room ID and try again.'});return}const name=cleanName(p?.username);r.participants.set(s.id,{id:s.id,username:name,isHost:false});s.join(id);socketRooms.set(s.id,id);system(r,`${name} joined the room`);ack?.({ok:true,roomId:id,room:snapshot(r)});emitRoom(r)});
 s.on('room:leave',()=>leave(s));
 s.on('chat:send',(p:{text?:string})=>{const r=member(s);if(!r)return fail(s,'Join a room before chatting.');const text=String(p?.text??'').trim();if(!text)return;if(text.length>500)return fail(s,'Messages must be 500 characters or fewer.');const person=r.participants.get(s.id)!;const m={id:randomBytes(8).toString('hex'),username:person.username,text,timestamp:Date.now()};r.messages.push(m);r.messages=r.messages.slice(-100);io.to(r.id).emit('chat:message',m)});
 s.on('video:load',(p:{url?:string})=>{const r=member(s);if(!r)return fail(s,'Join a room first.');if(r.hostId!==s.id)return fail(s,'Only the host can load a video.');const url=String(p?.url??'').trim();if(url.length>2000||!/^https?:\/\//i.test(url))return fail(s,'Enter a valid http or https video URL.');let u:URL;try{u=new URL(url)}catch{return fail(s,'Invalid video URL.')}const kind=/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(u.hostname)?'youtube':'direct';r.playback={url,kind,currentTime:0,isPlaying:false,updatedAt:Date.now()};io.to(r.id).emit('video:load',r.playback);emitRoom(r)});
 s.on('video:command',(p:{action?:string;currentTime?:number;isPlaying?:boolean})=>{const r=member(s);if(!r)return fail(s,'Join a room first.');if(r.hostId!==s.id)return fail(s,'Only the host can control playback.');if(!r.playback)return fail(s,'Load a video first.');if(!['play','pause','seek'].includes(String(p?.action)))return;const n=Number(p.currentTime);const t=Number.isFinite(n)?Math.max(0,Math.min(n,86400)):r.playback.currentTime;const action=p.action!;r.playback={...r.playback,currentTime:t,isPlaying:action==='play'?true:action==='pause'?false:Boolean(p.isPlaying??r.playback.isPlaying),updatedAt:Date.now()};io.to(r.id).emit('video:command',{action,currentTime:t,isPlaying:r.playback.isPlaying,updatedAt:r.playback.updatedAt,by:s.id})});
 s.on('video:sync-request',()=>{const r=member(s);if(!r?.playback)return;const state={...r.playback};if(state.isPlaying)state.currentTime+=(Date.now()-state.updatedAt)/1000;s.emit('video:sync-state',state)});
 s.on('disconnect',()=>leave(s));
});
const port=Number(process.env.PORT)||3001;server.listen(port,'0.0.0.0',()=>console.log(`WatchParty backend listening on port ${port}`));
