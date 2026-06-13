DARKWEAVER — SITE NETLIFY + PIX MERCADO PAGO + ENTREGA RCON

COMO SUBIR:
1. Envie este ZIP no Netlify Drop.
2. Vá em Project configuration > Environment variables.
3. Crie estas variáveis:

MERCADOPAGO_ACCESS_TOKEN = sua Access Token de produção do Mercado Pago
MC_RCON_HOST = zoe.lura.pro
MC_RCON_PORT = 35612
MC_RCON_PASSWORD = sua senha RCON do server.properties

4. Depois vá em Deploys e arraste o ZIP de novo para redeploy.

IMPORTANTE:
- Não coloque a Access Token no campo Key. O campo Key deve ser só o nome MERCADOPAGO_ACCESS_TOKEN.
- A chave do Mercado Pago e senha RCON ficam no backend do Netlify Functions, não no navegador.
- Se você mostrou a chave em print ou mandou para alguém, gere uma nova no Mercado Pago.
- O servidor precisa estar com enable-rcon=true e a porta RCON liberada.

ROTAS:
/api/kits                 lista kits
/api/kits/pix             gera PIX
/api/kits/pix/status/:id  consulta pagamento
/api/kits/pix/deliver     entrega kit via RCON quando pagamento aprovar
/api/online               mostra jogadores online via RCON
