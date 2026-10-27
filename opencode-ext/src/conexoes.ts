// Conexões rápidas: ferramentas de linha de comando que o usuário usa junto com
// o OpenCode (GitHub, Cloudflare Tunnel, Docker…). Aqui só se CONSULTA o estado;
// o login roda no terminal do VS Code com o comando oficial de cada ferramenta,
// e a extensão nunca vê senha nem token (a saída passa por `mascarar`).
import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Conexao {
  id: string;
  nome: string;
  icone: string;
  descricao: string;
  /** Comando que diz se está instalado/logado (sem segredos na saída). */
  status: string;
  /** Comando de login, rodado no terminal visível do VS Code. */
  login?: string;
  logout?: string;
  /** Como instalar, quando a ferramenta não existe. */
  instalar?: string;
  personalizada?: boolean;
}

export interface Estado {
  instalado: boolean;
  logado: boolean;
  detalhe: string;
}

export const PADRAO: Conexao[] = [
  { id: "github", nome: "GitHub", icone: "github", descricao: "Conta do gh: PRs, issues e push pelo OpenCode.", status: "gh auth status", login: "gh auth login --web", logout: "gh auth logout", instalar: "winget install --id GitHub.cli" },
  { id: "cloudflared", nome: "Cloudflare Tunnel", icone: "globe", descricao: "Túneis do cloudflared (expor o /pair ou um serviço com segurança).", status: "cloudflared --version", login: "cloudflared tunnel login", instalar: "winget install --id Cloudflare.cloudflared" },
  { id: "docker", nome: "Docker", icone: "box", descricao: "Docker Engine e login no registro.", status: "docker info --format \"{{.ServerVersion}}\"", login: "docker login", logout: "docker logout", instalar: "winget install --id Docker.DockerDesktop" },
  { id: "gcloud", nome: "Google Cloud", icone: "cloud", descricao: "Conta e projeto ativo do gcloud. Credenciais para SDKs e código local: gcloud auth application-default login.", status: "gcloud auth list --filter=status:ACTIVE --format=\"value(account)\"", login: "gcloud auth login", logout: "gcloud auth revoke", instalar: "winget install --id Google.CloudSDK" },
  { id: "firebase", nome: "Firebase", icone: "flame", descricao: "Conta do firebase-tools: deploy, emuladores e regras.", status: "firebase login:list", login: "firebase login", logout: "firebase logout", instalar: "npm i -g firebase-tools" },
  { id: "npm", nome: "npm", icone: "box", descricao: "Conta do registro npm.", status: "npm whoami", login: "npm login", logout: "npm logout" },
  { id: "git", nome: "Git (identidade)", icone: "pencil", descricao: "Nome e e-mail usados nos commits.", status: "git config --global user.name" },
];

/** Esconde tokens e chaves que alguma ferramenta imprima por engano. */
export function mascarar(texto: string): string {
  return texto
    .replace(/\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]{6,}/g, "$1****")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "eyJ****")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "$1-****")
    .replace(/((?:token|password|senha|secret|api[_-]?key)\s*[:=]\s*)(?!\S*\*\*\*\*)\S+/gi, "$1****");
}

function rodar(cmd: string, ms = 15_000): Promise<{ ok: boolean; saida: string; codigo: number }> {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: ms }, (err, out, errOut) => {
      const codigo = typeof err?.code === "number" ? err.code : err ? 1 : 0;
      resolve({ ok: !err, saida: mascarar(`${out}\n${errOut}`.trim()), codigo });
    });
  });
}

/** 9009 = "não é reconhecido" no cmd do Windows; 127 = command not found no sh. */
const naoExiste = (r: { codigo: number; saida: string }) => r.codigo === 9009 || r.codigo === 127 || /not recognized|reconhecido como|command not found|ENOENT/i.test(r.saida);

/** Contas na saída (gcloud/firebase saem com código 0 mesmo deslogados: vale o e-mail impresso). */
export function contasDe(saida: string): string[] {
  return [...new Set(saida.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [])];
}

/** Interpreta a saída de cada conexão conhecida; as personalizadas valem pelo código de saída. */
export async function checar(c: Conexao): Promise<Estado> {
  const r = await rodar(c.status);
  if (naoExiste(r)) return { instalado: false, logado: false, detalhe: "não instalado" };
  switch (c.id) {
    case "github": {
      const contas = [...r.saida.matchAll(/Logged in to (\S+) account (\S+)/g)].map((m) => `${m[2]} (${m[1]})`);
      return { instalado: true, logado: contas.length > 0, detalhe: contas.length ? contas.join(", ") : "não logado" };
    }
    case "cloudflared": {
      const cert = path.join(os.homedir(), ".cloudflared", "cert.pem");
      const versao = r.saida.match(/version (\S+)/)?.[1] ?? "";
      if (!fs.existsSync(cert)) return { instalado: r.ok, logado: false, detalhe: `${versao ? "v" + versao + " · " : ""}não logado` };
      const t = await rodar("cloudflared tunnel list --output json");
      let tuneis = 0;
      try {
        tuneis = JSON.parse(t.saida.slice(t.saida.indexOf("["))).length;
      } catch {}
      return { instalado: true, logado: true, detalhe: `logado · ${tuneis} túnel(is)` };
    }
    case "docker":
      return r.ok
        ? { instalado: true, logado: true, detalhe: `engine ${r.saida.split("\n")[0]} rodando` }
        : { instalado: true, logado: false, detalhe: /daemon|pipe|connect/i.test(r.saida) ? "Docker Desktop parado" : r.saida.split("\n")[0].slice(0, 120) };
    case "gcloud": {
      const contas = contasDe(r.saida);
      if (!contas.length) return { instalado: true, logado: false, detalhe: "não logado" };
      const p = await rodar("gcloud config get-value project");
      const projeto = p.ok ? p.saida.split("\n").find((l) => l && !/^\(unset\)$|WARNING|^Your active/i.test(l.trim()))?.trim() : undefined;
      return { instalado: true, logado: true, detalhe: `${contas.join(", ")} · ${projeto ? "projeto " + projeto : "sem projeto ativo"}` };
    }
    case "firebase": {
      const contas = contasDe(r.saida);
      return { instalado: true, logado: contas.length > 0, detalhe: contas.length ? contas.join(", ") : "não logado" };
    }
    case "npm":
      return r.ok ? { instalado: true, logado: true, detalhe: r.saida.split("\n")[0] } : { instalado: true, logado: false, detalhe: "não logado" };
    case "git": {
      const email = await rodar("git config --global user.email");
      return r.ok && r.saida ? { instalado: true, logado: true, detalhe: `${r.saida.split("\n")[0]}${email.ok && email.saida ? " <" + email.saida.split("\n")[0] + ">" : ""}` } : { instalado: true, logado: false, detalhe: "sem nome configurado" };
    }
    default:
      return { instalado: true, logado: r.ok, detalhe: r.saida.split("\n")[0]?.slice(0, 160) || (r.ok ? "ok" : "falhou") };
  }
}

/** Id para uma conexão nova a partir do nome. */
export function idDe(nome: string, usados: string[]): string {
  const base = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "conexao";
  let id = base, n = 2;
  while (usados.includes(id)) id = `${base}-${n++}`;
  return id;
}
