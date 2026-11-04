package bundle

import (
	"html/template"
	"net/http"
)

var oauthTemplate = template.Must(template.New("oauth").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{.Title}} · PocketContext</title>
<style>body{font:18px system-ui,sans-serif;background:#f5f3ed;color:#233c32;max-width:620px;margin:8vh auto;padding:24px;line-height:1.5;overflow-wrap:anywhere}button,a{font:inherit}button{padding:10px 18px;margin:8px 8px 8px 0;cursor:pointer}h1{line-height:1.15}#message{white-space:pre-wrap}li{margin:20px 0;overflow-wrap:anywhere}small{display:block;overflow-wrap:anywhere}a{color:inherit}</style>
<script src="/oauth/app.js" defer></script></head><body data-connections="{{.Connections}}"><p>PocketContext</p><h1>{{.Title}}</h1>
{{if .Connections}}<p>These apps can read and change knowledge in every space. Revoke access to disconnect an app.</p><ul id="connections"></ul><button id="reload">Refresh connections</button>
{{else}}<p><strong>{{.Name}}</strong> is asking to read and change your knowledge in every space, including originals, citations and published pages.</p><p>This does not grant server administration or shell access.</p><p>The app name is supplied by its developer. Check that you intended to connect it.</p><small>Registered callback: {{.Redirect}}</small><button id="approve">Allow access</button><button id="deny">Cancel</button>{{end}}
<p id="message" role="status"></p><p>If you are not signed in, open your fresh PocketContext reader sign-in link in another tab of this browser, then return here. Your setup agent can issue one with <code>open --public</code>. You can also <a href="/" target="_blank" rel="noopener">open the reader</a> and use your password if you set one.</p><p><a href="/oauth/connections">Manage connected apps</a></p></body></html>`))

func oauthPage(w http.ResponseWriter, title, name, redirect string, connections bool) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = oauthTemplate.Execute(w, struct {
		Title, Name, Redirect string
		Connections           bool
	}{title, name, redirect, connections})
}

const oauthScript = `"use strict";
const message=document.getElementById("message");
function token(){try{return JSON.parse(localStorage.getItem("pocketcontext.reader.auth")||"{}").token||""}catch{return ""}}
async function request(path,body){
 const t=token();if(!t)throw Error("Sign in to the reader in this browser first, then return here.");
 const response=await fetch(path,{method:body===undefined?"GET":"POST",credentials:"omit",headers:{Authorization:"Bearer "+t,Accept:"application/json","Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),redirect:"error"});
 const result=await response.json();if(!response.ok)throw Error(result.error_description||"Request failed. Please sign in again.");return result;
}
async function consent(approve){
 const buttons=document.querySelectorAll("button");buttons.forEach(b=>b.disabled=true);message.textContent="";
 try{const result=await request("/oauth/authorize"+location.search,{approve});location.assign(result.redirect)}catch(e){message.textContent=e.message;buttons.forEach(b=>b.disabled=false)}
}
async function connections(){
 const list=document.getElementById("connections");list.replaceChildren();message.textContent="";
 try{const result=await request("/oauth/connections");for(const item of result.connections){const li=document.createElement("li"),label=document.createElement("span"),button=document.createElement("button");label.textContent=item.name+" — connected "+new Date(item.created*1000).toLocaleDateString();button.textContent="Revoke access";button.onclick=async()=>{button.disabled=true;try{await request("/oauth/connections",{id:item.id});await connections();message.textContent="Access revoked."}catch(e){message.textContent=e.message;button.disabled=false}};li.append(label,document.createElement("br"),button);list.append(li)}if(!result.connections.length)message.textContent="No connected apps."}catch(e){message.textContent=e.message}
}
if(document.body.dataset.connections==="true"){document.getElementById("reload").onclick=connections;connections()}else{document.getElementById("approve").onclick=()=>consent(true);document.getElementById("deny").onclick=()=>consent(false)}
`
