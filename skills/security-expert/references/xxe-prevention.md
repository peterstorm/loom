# XXE (XML External Entity) Prevention Reference

## The Attack

Attacker injects malicious XML that references external entities to read files, trigger SSRF, or cause denial of service.

```xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<userInfo><name>&xxe;</name></userInfo>
```

## Attack Variants

### File Read
```xml
<!ENTITY xxe SYSTEM "file:///etc/passwd">
```

### SSRF
```xml
<!ENTITY xxe SYSTEM "http://internal-service/admin">
```

### Billion Laughs (DoS)
```xml
<!ENTITY lol "lol">
<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
<!-- Exponential expansion → OOM -->
```

## Where XXE Occurs in Java/Spring

- SOAP web services
- XML file uploads/imports
- RSS/Atom feed parsing
- SVG processing
- Office document parsing (OOXML is ZIP of XML)
- SAML authentication
- XML configuration parsing

## Prevention

### SAXParserFactory
```java
SAXParserFactory factory = SAXParserFactory.newInstance();
factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
```

### DocumentBuilderFactory
```java
DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
factory.setXIncludeAware(false);
factory.setExpandEntityReferences(false);
```

### XMLInputFactory (StAX)
```java
XMLInputFactory factory = XMLInputFactory.newInstance();
factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);
factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
```

### JAXB
```java
// JAXB uses SAXParser internally — configure the source
SAXParserFactory spf = SAXParserFactory.newInstance();
spf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);

Source xmlSource = new SAXSource(spf.newSAXParser().getXMLReader(),
    new InputSource(inputStream));
JAXBContext context = JAXBContext.newInstance(MyClass.class);
MyClass obj = (MyClass) context.createUnmarshaller().unmarshal(xmlSource);
```

### Spring Web Services (SOAP)
```java
@Bean
public Wss4jSecurityInterceptor securityInterceptor() {
    // Spring WS uses secure defaults since 5.x
    // But verify your XML parser config
}

// For RestTemplate consuming XML
@Bean
public RestTemplate restTemplate() {
    // Use Jackson XML instead of JAXB where possible
    RestTemplate template = new RestTemplate();
    // Jackson XML is not vulnerable to XXE by default
    return template;
}
```

### Spring Boot Auto-configuration
```yaml
# If not using XML endpoints, disable XML message converters
spring:
  mvc:
    converters:
      preferred-json-mapper: jackson
# Remove Jaxb2RootElementHttpMessageConverter if not needed
```

## Testing
```java
@Test
void shouldBlockXXE() {
    String xxePayload = """
        <?xml version="1.0"?>
        <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
        <input><value>&xxe;</value></input>
        """;

    mockMvc.perform(post("/api/import")
            .contentType(MediaType.APPLICATION_XML)
            .content(xxePayload))
        .andExpect(status().isBadRequest());
}
```

## Quick Reference

| Parser | Disable DTD | Disable External Entities |
|--------|-------------|--------------------------|
| SAXParserFactory | `disallow-doctype-decl = true` | `external-general-entities = false` |
| DocumentBuilderFactory | `disallow-doctype-decl = true` | `external-general-entities = false` |
| XMLInputFactory | `SUPPORT_DTD = false` | `IS_SUPPORTING_EXTERNAL_ENTITIES = false` |
| JAXB | Configure underlying SAXParser | Same as SAX |

**Simplest rule: If you don't need DTDs, disable them entirely with `disallow-doctype-decl`.**
