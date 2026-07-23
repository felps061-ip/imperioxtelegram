# Promobank x Telegram — MVP Extrato INSS

MVP interno para receber um CPF em uma conversa privada do Telegram, colocar a solicitação em uma fila sequencial, consultar o Meu INSS no Promobank e devolver o PDF ao vendedor autorizado.

## Escopo desta versão

- Um bot Telegram por long polling, sem necessidade de domínio público ou webhook.
- Apenas conversas privadas e usuários incluídos na lista de autorização.
- CPF com ou sem pontuação, inclusive enviado sem comando.
- Validação dos dígitos verificadores do CPF.
- Uma fila em memória e um processamento por vez.
- Login e perfil persistente do Chrome no computador autorizado.
- Navegação até `Serviços → Meu INSS` dentro do iframe do Promobank.
- Captura da nova aba HTTPS e download autenticado do PDF.
- PDF mantido somente em memória até o envio ao Telegram.
- Logs com CPF mascarado e URLs sem parâmetros.

O MVP ainda não inclui SIAPE, segundo computador, banco de dados persistente ou painel administrativo.

## Requisitos

- Windows com Google Chrome instalado.
- Node.js 22 ou superior.
- Um bot criado pelo [@BotFather](https://t.me/BotFather).
- Um login do Promobank autorizado para este computador.
- O perfil do Chrome do robô não pode estar aberto em outro processo.

## Instalação

No PowerShell, dentro desta pasta:

```powershell
npm.cmd install
$configDir = Join-Path $env:LOCALAPPDATA 'PromobankTelegramBot'
New-Item -ItemType Directory -Path $configDir -Force
Copy-Item -LiteralPath '.env.example' -Destination (Join-Path $configDir '.env')
notepad (Join-Path $configDir '.env')
```

O arquivo de configuração fica em `%LOCALAPPDATA%\PromobankTelegramBot\.env`, fora da pasta sincronizada pelo OneDrive. Configure, no mínimo:

```dotenv
TELEGRAM_BOT_TOKEN=token_recebido_do_botfather
TELEGRAM_ALLOWED_USER_IDS=
PROMOBANK_COMPANY=
PROMOBANK_USERNAME=
PROMOBANK_PASSWORD=
```

Não envie esse arquivo por Telegram, e-mail ou chat. Também é possível escolher outro caminho local definindo a variável de ambiente `PROMOBANK_ENV_FILE` antes de iniciar o processo.

### Descobrir o ID de um vendedor

1. Inicie o bot com `TELEGRAM_ALLOWED_USER_IDS` vazio.
2. O vendedor abre uma conversa privada com o bot e envia `/meuid`.
3. O bot informa somente o ID daquela pessoa.
4. Pare o processo, abra novamente o arquivo em `%LOCALAPPDATA%\PromobankTelegramBot\.env`, adicione os IDs separados por vírgula e inicie novamente:

```dotenv
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

Com a lista vazia, nenhuma consulta é autorizada.

`TELEGRAM_PROTECT_CONTENT=false` permite que o vendedor salve ou encaminhe o documento. Troque para `true` se a política interna exigir a proteção de conteúdo oferecida pelo Telegram.

## Login do Promobank

Há duas formas de operar:

### Login automático

Preencha as três variáveis abaixo no `.env`:

```dotenv
PROMOBANK_COMPANY=
PROMOBANK_USERNAME=
PROMOBANK_PASSWORD=
```

As três precisam estar preenchidas juntas. O robô não registra esses valores em logs.

### Login manual assistido

Deixe as três variáveis vazias. Na primeira solicitação, o Chrome dedicado abrirá a página do Promobank e o protocolo falhará solicitando intervenção. Faça o login manualmente nesse Chrome e reenvie a solicitação. Por padrão, a sessão será preservada em `%LOCALAPPDATA%\PromobankTelegramBot\chrome-profile`, fora do OneDrive.

Use esse perfil somente para o robô. Não use o perfil padrão do vendedor e não abra o perfil do robô enquanto o processo estiver ativo.

## Executar

```powershell
npm.cmd start
```

Comandos disponíveis em conversa privada:

```text
/inss 123.456.789-00
/status ABCD1234
/meuid
/ajuda
```

O vendedor também pode enviar apenas o CPF.

## Segurança operacional

- O bot recusa consultas em grupos.
- O acesso é validado pelo ID numérico do Telegram, não pelo nome de usuário.
- O CPF completo existe somente na memória enquanto o trabalho está ativo.
- O nome do PDF contém o protocolo, nunca o CPF.
- A URL financeira do PDF é capturada dinamicamente e nunca é registrada com a query string.
- O PDF não é salvo em disco pelo aplicativo.
- Credenciais e sessão do Chrome ficam fora da pasta sincronizada pelo OneDrive.
- Se o Promobank informar sessão em outro computador, o robô para. Ele não encerra a outra sessão automaticamente.
- O perfil persistente deve ficar no mesmo computador vinculado ao login.

Como o PDF passa pelo Telegram, a empresa deve validar internamente a base legal, a autorização de cada consulta e a política de uso/retensão do canal.

## Testes

```powershell
npm.cmd test
```

Os testes locais não acessam o Promobank nem o Telegram.

## Limitações conhecidas do MVP

- A fila é mantida em memória. Se o processo for encerrado, pedidos ainda não executados precisam ser reenviados.
- Esta versão utiliza somente um login e um computador.
- Alterações na interface do Promobank podem exigir atualização dos seletores.
- CAPTCHA, 2FA e conflitos de sessão exigem intervenção humana.
- O fluxo real precisa de um teste acompanhado com CPF autorizado antes de entrar em produção.

## Próxima evolução

Depois do piloto com um login, a segunda etapa separará o sistema em:

```text
Bot/coordenador → fila central → Worker A / Login A
                              → Worker B / Login B
```

Cada worker continuará preso ao seu computador e processará somente um pedido por vez.
