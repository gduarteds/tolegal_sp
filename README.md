# OSINT Investigator

Sistema de investigação de fraudes de licenças falsas (TôLegal) e sites de phishing.

## Deploy no GitHub Pages

1. Crie um repositório no GitHub (ex: `osint-investigator`)
2. Faça upload de todos os arquivos mantendo a estrutura:
   ```
   index.html
   css/style.css
   js/app.js
   ```
3. Vá em **Settings → Pages → Source: main branch → / (root)**
4. Acesse via `https://seu-usuario.github.io/osint-investigator`

## Login

- **Email:** gduarteds@gmail.com  
- **Senha:** Pentester*90

## Funcionalidades

- **Home:** Centro de operações com histórico de sites fraudulentos/phishing, IPs e investigações
- **Target Profile:** Cadastro de suspeitos com foto, silhueta, brasão e campos de inteligência
- **Licenças Falsas — TôLegal:** Busca por nome, CPF/CNPJ ou logradouro + impressão
- **Database:** Upload de HTMLs com licenças falsas (até 444 arquivos) e sitemaps
- **Whois/Gobuster:** Consulta Whois, Reverse IP, varredura simulada e análise com IA (Groq)

## API Groq (opcional)

Para análise de domínios com IA, obtenha sua chave gratuita em https://console.groq.com
A chave é solicitada no primeiro uso e salva localmente no dispositivo.

## Dados

Todos os dados são armazenados localmente via `localStorage` do navegador.
Não há servidor — funciona 100% no frontend (GitHub Pages compatível).
