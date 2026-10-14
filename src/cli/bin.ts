import { main } from './main'

void main(process.argv.slice(2)).then((out) => {
  process.stdout.write(out.stdout)
  process.exitCode = out.exitCode
})
