// Prints a new VAPID key pair for push notifications. Run it yourself and copy the two lines into the DigitalOcean app
// environment (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY). The private key is a secret: never commit it or paste it into a chat.
import webpush from 'web-push'

const keys = webpush.generateVAPIDKeys()
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`)
console.log('VAPID_SUBJECT=mailto:<адрес диспетчерской>')
